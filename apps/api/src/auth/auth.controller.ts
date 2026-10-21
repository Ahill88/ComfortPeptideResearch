import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { readSessionCookieToken, type HeadersLike, type SessionIdentity } from '../wallet/customer-identity';
import { AccountService } from './account.service';
import { AuthRequestGuard, CookieSessionGuard } from './auth-request.guard';
import { buildClearedSessionCookie, buildSessionCookie, USER_AGENT_MAX } from './auth.config';
import { AuthService, type LoginContext } from './auth.service';
import { AddressRequest, LoginRequest, MfaCodeRequest, MfaDisableRequest, PasswordResetConfirmRequest, PasswordResetRequest, RegisterRequest, TokenRequest, UpdateProfileRequest } from './auth.dto';

type Req = { headers: HeadersLike; ip?: string; customerSession?: SessionIdentity };
type Res = { setHeader: (name: string, value: string) => void };

const contextOf = (req: Req): LoginContext => {
  const agent = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof agent === 'string' ? agent.slice(0, USER_AGENT_MAX) : null, previousToken: readSessionCookieToken(req.headers) };
};
const me = (req: Req): string => (req.customerSession as SessionIdentity).customerId;

/**
 * Customer accounts, contract section 2 (docs/api/customer-auth.md). Bodies are read untyped on purpose (validated in
 * auth.validation.ts) so malformed input to sign-in is the same 401 as a wrong password, and every error body is `{message}`.
 */
@ApiTags('auth')
@UseGuards(AuthRequestGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly account: AccountService) {}

  @Post('register') @HttpCode(202)
  @ApiOperation({ summary: 'Register (identical 202 for new and existing emails; sends a verification email)' }) @ApiBody({ type: RegisterRequest })
  register(@Body() body: unknown) { return this.auth.register(body); }

  @Post('email-verification/confirm') @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an email-verification token (single use, 24 h)' }) @ApiBody({ type: TokenRequest })
  async confirmEmail(@Body() body: unknown): Promise<void> { await this.auth.confirmEmail(body); }

  @Post('login') @HttpCode(200)
  @ApiOperation({ summary: 'Sign in; sets the hf_session cookie. Every failure is 401 {message:"Invalid sign-in."}' }) @ApiBody({ type: LoginRequest })
  async login(@Body() body: unknown, @Req() req: Req, @Res({ passthrough: true }) res: Res) {
    const { customer, token } = await this.auth.login(body, contextOf(req));
    res.setHeader('Set-Cookie', buildSessionCookie(token));
    return { customer };
  }

  @Post('logout') @HttpCode(204)
  @ApiOperation({ summary: 'Revoke the session and clear the cookie (always 204)' })
  async logout(@Req() req: Req, @Res({ passthrough: true }) res: Res): Promise<void> {
    await this.auth.logout(readSessionCookieToken(req.headers));
    res.setHeader('Set-Cookie', buildClearedSessionCookie());
  }

  @Get('session') @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'The signed-in customer' })
  async session(@Req() req: Req) { return { customer: await this.auth.sessionCustomer(me(req)) }; }

  @Post('password-reset/request') @HttpCode(202)
  @ApiOperation({ summary: 'Request a password-reset email (identical 202 for every address)' }) @ApiBody({ type: PasswordResetRequest })
  requestReset(@Body() body: unknown) { return this.auth.requestPasswordReset(body); }

  @Post('password-reset/confirm') @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password with a reset token (single use, 1 h); revokes every session' }) @ApiBody({ type: PasswordResetConfirmRequest })
  async confirmReset(@Body() body: unknown): Promise<void> { await this.auth.confirmPasswordReset(body); }

  @Post('mfa/enroll') @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Start MFA enrolment: returns the otpauth URI and base32 seed once' })
  enrollMfa(@Req() req: Req) { return this.account.enrollMfa(me(req)); }

  @Post('mfa/enroll/confirm') @HttpCode(204) @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Confirm MFA enrolment with a current code' }) @ApiBody({ type: MfaCodeRequest })
  async confirmMfa(@Body() body: unknown, @Req() req: Req): Promise<void> { await this.account.confirmMfaEnrollment(me(req), body); }

  @Post('mfa/disable') @HttpCode(204) @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Disable MFA (password + current code)' }) @ApiBody({ type: MfaDisableRequest })
  async disableMfa(@Body() body: unknown, @Req() req: Req): Promise<void> { await this.account.disableMfa(me(req), body); }

  @Get('profile') @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Profile' })
  profile(@Req() req: Req) { return this.account.profile(me(req)); }

  @Patch('profile') @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Update the display name' }) @ApiBody({ type: UpdateProfileRequest })
  updateProfile(@Body() body: unknown, @Req() req: Req) { return this.account.updateProfile(me(req), body); }

  @Get('addresses') @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Saved addresses (default first)' })
  addresses(@Req() req: Req) { return this.account.listAddresses(me(req)); }

  @Post('addresses') @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Add an address (at most 20; the first one becomes the default)' }) @ApiBody({ type: AddressRequest })
  createAddress(@Body() body: unknown, @Req() req: Req) { return this.account.createAddress(me(req), body); }

  @Patch('addresses/:id') @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Update an address; isDefault:true moves the default' }) @ApiBody({ type: AddressRequest })
  updateAddress(@Param('id') id: string, @Body() body: unknown, @Req() req: Req) { return this.account.updateAddress(me(req), id, body); }

  @Delete('addresses/:id') @HttpCode(204) @UseGuards(CookieSessionGuard)
  @ApiOperation({ summary: 'Delete an address (the oldest remaining becomes the default if needed)' })
  async deleteAddress(@Param('id') id: string, @Req() req: Req): Promise<void> { await this.account.deleteAddress(me(req), id); }
}

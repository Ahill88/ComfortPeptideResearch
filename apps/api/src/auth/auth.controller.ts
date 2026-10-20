import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { AddressRequest, AddressResponse, AuthUnavailableResponse, EmailVerificationRequest, LoginRequest, MfaEnrollmentConfirmRequest, MfaEnrollmentRequest, MfaEnrollmentResponse, PasswordResetConfirmRequest, PasswordResetRequest, ProfileResponse, RegisterRequest, UpdateAddressRequest, UpdateProfileRequest } from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register') @ApiOperation({ summary: 'Register an account' }) @ApiCreatedResponse({ description: 'Account created.', type: ProfileResponse }) @ApiServiceUnavailableResponse({ description: 'Credential persistence is not configured.', type: AuthUnavailableResponse })
  register(@Body() body: RegisterRequest) { return this.auth.register(body); }
  @Post('login') @ApiOperation({ summary: 'Authenticate and create a session' }) @ApiOkResponse({ description: 'Authenticated session.', schema: { example: { accessToken: '...', tokenType: 'Bearer' } } }) @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  login(@Body() body: LoginRequest) { return this.auth.login(body); }
  @Post('password-reset/request') @ApiOperation({ summary: 'Request a password-reset email' }) @ApiNoContentResponse() @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  requestPasswordReset(@Body() body: PasswordResetRequest) { return this.auth.requestPasswordReset(body); }
  @Post('password-reset/confirm') @ApiOperation({ summary: 'Set a password with a reset token' }) @ApiNoContentResponse() @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  confirmPasswordReset(@Body() body: PasswordResetConfirmRequest) { return this.auth.confirmPasswordReset(body); }
  @Post('email-verification/confirm') @ApiOperation({ summary: 'Confirm an email-verification token' }) @ApiNoContentResponse() @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  verifyEmail(@Body() body: EmailVerificationRequest) { return this.auth.verifyEmail(body); }

  @Get('profile') @ApiBearerAuth() @ApiOperation({ summary: 'Get the authenticated profile' }) @ApiOkResponse({ type: ProfileResponse }) @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  profile() { return this.auth.profile(); }
  @Patch('profile') @ApiBearerAuth() @ApiOperation({ summary: 'Update the authenticated profile' }) @ApiOkResponse({ type: ProfileResponse }) @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  updateProfile(@Body() body: UpdateProfileRequest) { return this.auth.updateProfile(body); }
  @Get('addresses') @ApiBearerAuth() @ApiOperation({ summary: 'List authenticated account addresses' }) @ApiOkResponse({ type: AddressResponse, isArray: true }) @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  addresses() { return this.auth.addresses(); }
  @Post('addresses') @ApiBearerAuth() @ApiOperation({ summary: 'Create an address for the authenticated account' }) @ApiCreatedResponse({ type: AddressResponse }) @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  createAddress(@Body() body: AddressRequest) { return this.auth.createAddress(body); }
  @Patch('addresses/:addressId') @ApiBearerAuth() @ApiOperation({ summary: 'Update an authenticated account address' }) @ApiParam({ name: 'addressId', example: 'addr_01J...' }) @ApiOkResponse({ type: AddressResponse }) @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  updateAddress(@Param('addressId') addressId: string, @Body() body: UpdateAddressRequest) { return this.auth.updateAddress(addressId, body); }
  @Delete('addresses/:addressId') @ApiBearerAuth() @ApiOperation({ summary: 'Delete an authenticated account address' }) @ApiParam({ name: 'addressId', example: 'addr_01J...' }) @ApiNoContentResponse() @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  deleteAddress(@Param('addressId') addressId: string) { return this.auth.deleteAddress(addressId); }
  @Post('mfa/enroll') @ApiBearerAuth() @ApiOperation({ summary: 'Begin MFA enrollment' }) @ApiCreatedResponse({ type: MfaEnrollmentResponse }) @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  enrollMfa(@Body() body: MfaEnrollmentRequest) { return this.auth.enrollMfa(body); }
  @Post('mfa/enroll/confirm') @ApiBearerAuth() @ApiOperation({ summary: 'Confirm MFA enrollment' }) @ApiNoContentResponse() @ApiServiceUnavailableResponse({ type: AuthUnavailableResponse })
  confirmMfaEnrollment(@Body() body: MfaEnrollmentConfirmRequest) { return this.auth.confirmMfaEnrollment(body); }
}

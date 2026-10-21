import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoles, CurrentAdmin } from '../admin.decorators';
import { AdminSessionGuard } from '../admin-session.guard';
import type { AdminPrincipal, AdminRequest } from '../admin.types';
import { ChangePasswordRequest, CreateAdminUserRequest } from './admin-auth.dto';
import { AdminAuthService, USER_AGENT_MAX, type RequestContext } from './admin-auth.service';

const contextOf = (req: AdminRequest): RequestContext => {
  const agent = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof agent === 'string' ? agent.slice(0, USER_AGENT_MAX) : null };
};

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  // Body is read untyped on purpose: ANY malformed body must produce the same 401 as a wrong password.
  @Post('login') @HttpCode(200) @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Admin sign-in (password + TOTP). Every failure is 401 {message:"Invalid sign-in."}.' })
  @ApiBody({ schema: { type: 'object', required: ['email', 'password', 'totp'], properties: { email: { type: 'string' }, password: { type: 'string' }, totp: { type: 'string', example: '123456' } } } })
  login(@Body() body: unknown, @Req() req: AdminRequest) {
    return this.auth.login(body, contextOf(req));
  }

  @Get('me') @UseGuards(AdminSessionGuard) @ApiBearerAuth() @Header('Cache-Control', 'no-store')
  me(@CurrentAdmin() admin: AdminPrincipal, @Req() req: AdminRequest) {
    return this.auth.me(admin, req.adminSessionId as string);
  }

  @Post('logout') @HttpCode(204) @UseGuards(AdminSessionGuard) @ApiBearerAuth()
  async logout(@CurrentAdmin() admin: AdminPrincipal, @Req() req: AdminRequest): Promise<void> {
    await this.auth.logout(admin, req.adminSessionId as string, contextOf(req));
  }

  @Post('change-password') @HttpCode(204) @UseGuards(AdminSessionGuard) @ApiBearerAuth()
  async changePassword(@CurrentAdmin() admin: AdminPrincipal, @Body() body: ChangePasswordRequest, @Req() req: AdminRequest): Promise<void> {
    await this.auth.changePassword(admin, req.adminSessionId as string, body, contextOf(req));
  }
}

@ApiTags('admin-users')
@ApiBearerAuth()
@UseGuards(AdminSessionGuard)
@AdminRoles('OWNER')
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly auth: AdminAuthService) {}

  @Get('users') @Header('Cache-Control', 'no-store')
  list() {
    return this.auth.listUsers();
  }

  /** The temporary password and MFA seed in the response are shown once and never stored in recoverable form. */
  @Post('users') @Header('Cache-Control', 'no-store')
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() body: CreateAdminUserRequest, @Req() req: AdminRequest) {
    return this.auth.createUser(admin, body, contextOf(req));
  }

  @Post('users/:id/deactivate') @HttpCode(204)
  async deactivate(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string, @Req() req: AdminRequest): Promise<void> {
    await this.auth.deactivateUser(admin, id, contextOf(req));
  }

  @Get('audit') @Header('Cache-Control', 'no-store')
  audit(@Query() query: Record<string, unknown>) {
    return this.auth.listAudit(query);
  }
}

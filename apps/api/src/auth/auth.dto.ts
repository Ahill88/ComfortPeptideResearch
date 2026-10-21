import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Documentation-only shapes (Swagger). Handlers read bodies as `unknown` and validate in auth.validation.ts, so that
 * malformed input produces the contract's exact statuses and `{message}` bodies instead of the global ValidationPipe's.
 */
export class RegisterRequest {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ minLength: 12, maxLength: 256, format: 'password' }) password!: string;
  @ApiPropertyOptional({ maxLength: 120 }) name?: string;
}
export class LoginRequest {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ format: 'password' }) password!: string;
  @ApiPropertyOptional({ example: '123456' }) totp?: string;
}
export class TokenRequest {
  @ApiProperty({ description: 'One-time token from the emailed link.' }) token!: string;
}
export class PasswordResetRequest {
  @ApiProperty({ format: 'email' }) email!: string;
}
export class PasswordResetConfirmRequest {
  @ApiProperty() token!: string;
  @ApiProperty({ minLength: 12, maxLength: 256, format: 'password' }) newPassword!: string;
}
export class MfaCodeRequest {
  @ApiProperty({ example: '123456' }) code!: string;
}
export class MfaDisableRequest {
  @ApiProperty({ format: 'password' }) password!: string;
  @ApiProperty({ example: '123456' }) code!: string;
}
export class UpdateProfileRequest {
  @ApiProperty({ maxLength: 120, nullable: true }) name!: string | null;
}
export class AddressRequest {
  @ApiPropertyOptional({ maxLength: 80, nullable: true }) label?: string | null;
  @ApiProperty({ maxLength: 120 }) recipient!: string;
  @ApiProperty({ maxLength: 160 }) line1!: string;
  @ApiPropertyOptional({ maxLength: 160, nullable: true }) line2?: string | null;
  @ApiProperty({ maxLength: 100 }) city!: string;
  @ApiProperty({ maxLength: 100 }) region!: string;
  @ApiProperty({ maxLength: 32 }) postalCode!: string;
  @ApiProperty({ example: 'US', description: 'ISO 3166-1 alpha-2' }) country!: string;
  @ApiPropertyOptional() isDefault?: boolean;
}

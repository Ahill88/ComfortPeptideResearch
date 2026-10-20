import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsStrongPassword,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterRequest {
  @ApiProperty({ example: 'researcher@example.com', format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'At least 12 characters including upper- and lower-case letters, a number, and a symbol.', minLength: 12, format: 'password' })
  @IsStrongPassword({ minLength: 12, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })
  password!: string;

  @ApiPropertyOptional({ example: 'Dr. Ada Lovelace', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class LoginRequest {
  @ApiProperty({ example: 'researcher@example.com', format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ format: 'password' })
  @IsString()
  @Length(1, 1024)
  password!: string;
}

export class PasswordResetRequest {
  @ApiProperty({ example: 'researcher@example.com', format: 'email' })
  @IsEmail()
  email!: string;
}

export class PasswordResetConfirmRequest {
  @ApiProperty({ description: 'One-time password-reset token delivered by the configured email provider.', minLength: 16, maxLength: 2048 })
  @IsString()
  @Length(16, 2048)
  token!: string;

  @ApiProperty({ minLength: 12, format: 'password' })
  @IsStrongPassword({ minLength: 12, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })
  password!: string;
}

export class EmailVerificationRequest {
  @ApiProperty({ description: 'One-time email-verification token.', minLength: 16, maxLength: 2048 })
  @IsString()
  @Length(16, 2048)
  token!: string;
}

export class UpdateProfileRequest {
  @ApiPropertyOptional({ example: 'Dr. Ada Lovelace', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class AddressRequest {
  @ApiProperty({ example: 'Laboratory' })
  @IsString()
  @Length(1, 80)
  label!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @Length(1, 120)
  recipient!: string;

  @ApiProperty({ example: '123 Research Way' })
  @IsString()
  @Length(1, 160)
  line1!: string;

  @ApiPropertyOptional({ example: 'Suite 400' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  line2?: string;

  @ApiProperty({ example: 'Boston' })
  @IsString()
  @Length(1, 100)
  city!: string;

  @ApiPropertyOptional({ example: 'MA' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiProperty({ example: '02110' })
  @IsString()
  @Length(1, 32)
  postalCode!: string;

  @ApiProperty({ example: 'US', minLength: 2, maxLength: 2 })
  @Matches(/^[A-Z]{2}$/)
  countryCode!: string;
}

export class UpdateAddressRequest extends AddressRequest {}

export class MfaEnrollmentConfirmRequest {
  @ApiProperty({ description: 'Enrollment challenge ID returned by a configured MFA provider.', minLength: 16, maxLength: 2048 })
  @IsString()
  @Length(16, 2048)
  enrollmentId!: string;

  @ApiProperty({ description: 'Current time-based one-time password.', example: '123456', minLength: 6, maxLength: 8 })
  @Matches(/^\d{6,8}$/)
  code!: string;
}

export class MfaEnrollmentRequest {
  @ApiPropertyOptional({ description: 'Optional device label.', example: 'Authenticator app', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class AddressResponse extends AddressRequest {
  @ApiProperty({ example: 'addr_01J...' })
  id!: string;
}

export class ProfileResponse {
  @ApiProperty({ example: 'cus_01J...' })
  id!: string;

  @ApiProperty({ example: 'researcher@example.com', format: 'email' })
  email!: string;

  @ApiPropertyOptional({ example: 'Dr. Ada Lovelace' })
  name?: string;

  @ApiProperty({ example: false })
  emailVerified!: boolean;

  @ApiProperty({ example: false })
  mfaEnabled!: boolean;

  @ApiProperty({ type: () => [AddressResponse] })
  @ValidateNested({ each: true })
  @Type(() => AddressResponse)
  addresses!: AddressResponse[];
}

export class MfaEnrollmentResponse {
  @ApiProperty({ example: 'mfa_enroll_01J...' })
  enrollmentId!: string;

  @ApiProperty({ description: 'Base32 TOTP secret. Only returned during enrollment.', example: 'JBSWY3DPEHPK3PXP' })
  secret!: string;

  @ApiProperty({ description: 'otpauth URI suitable for a QR code encoder.' })
  otpauthUri!: string;
}

export class AuthUnavailableResponse {
  @ApiProperty({ example: 503 })
  statusCode!: number;

  @ApiProperty({ example: 'Authentication persistence is not configured; this operation is unavailable.' })
  message!: string;

  @ApiProperty({ example: 'Service Unavailable' })
  error!: string;
}

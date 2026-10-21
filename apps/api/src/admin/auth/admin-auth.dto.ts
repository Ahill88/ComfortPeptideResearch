import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './credentials';

export class ChangePasswordRequest {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX_LENGTH) currentPassword!: string;
  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }) @IsString() @MinLength(PASSWORD_MIN_LENGTH) @MaxLength(PASSWORD_MAX_LENGTH) newPassword!: string;
}

export class CreateAdminUserRequest {
  // Format is validated by the service (shared EMAIL_PATTERN) so every entry point, including the CLI, accepts the same addresses.
  @ApiProperty() @IsString() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ enum: ['OWNER', 'STAFF'] }) @IsIn(['OWNER', 'STAFF']) role!: 'OWNER' | 'STAFF';
}

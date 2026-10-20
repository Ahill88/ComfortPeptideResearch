import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AddressRequest, EmailVerificationRequest, LoginRequest, MfaEnrollmentConfirmRequest, MfaEnrollmentRequest, PasswordResetConfirmRequest, PasswordResetRequest, RegisterRequest, UpdateAddressRequest, UpdateProfileRequest } from './auth.dto';

@Injectable()
export class AuthService {
  private unavailable(operation: string): never {
    throw new ServiceUnavailableException(`Authentication persistence and provider configuration are required for ${operation}; this operation is unavailable.`);
  }

  register(_request: RegisterRequest): never { return this.unavailable('registration'); }
  login(_request: LoginRequest): never { return this.unavailable('login'); }
  requestPasswordReset(_request: PasswordResetRequest): never { return this.unavailable('password-reset delivery'); }
  confirmPasswordReset(_request: PasswordResetConfirmRequest): never { return this.unavailable('password reset'); }
  verifyEmail(_request: EmailVerificationRequest): never { return this.unavailable('email verification'); }
  profile(): never { return this.unavailable('profile retrieval'); }
  updateProfile(_request: UpdateProfileRequest): never { return this.unavailable('profile updates'); }
  addresses(): never { return this.unavailable('address retrieval'); }
  createAddress(_request: AddressRequest): never { return this.unavailable('address creation'); }
  updateAddress(_addressId: string, _request: UpdateAddressRequest): never { return this.unavailable('address updates'); }
  deleteAddress(_addressId: string): never { return this.unavailable('address deletion'); }
  enrollMfa(_request: MfaEnrollmentRequest): never { return this.unavailable('MFA enrollment'); }
  confirmMfaEnrollment(_request: MfaEnrollmentConfirmRequest): never { return this.unavailable('MFA enrollment confirmation'); }
}

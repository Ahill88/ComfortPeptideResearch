export type Customer = {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  mfaEnabled: boolean;
};

export type EligibilityStatus = 'NOT_REQUESTED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'UNKNOWN';

/** Compatibility fields are derived from the API, never browser storage. */
export type CustomerSession = {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  eligible: boolean;
  eligibilityStatus: EligibilityStatus;
  mfaEnabled: boolean;
};

export type AddressInput = {
  label: string | null;
  recipient: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
};
export type Address = AddressInput & { id: string };
export type MfaEnrollment = { otpauthUri: string; seedBase32: string };

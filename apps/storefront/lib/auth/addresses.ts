import type { Address, AddressInput } from './types';

/** Plain text for the existing checkout shippingAddress field. Labels and account identifiers are excluded. */
export function formatAddress(address: AddressInput): string {
  const locality = [address.city.trim(), address.region.trim()].filter(Boolean).join(', ');
  return [address.recipient, address.line1, address.line2, [locality, address.postalCode.trim()].filter(Boolean).join(' '), address.country.toUpperCase()]
    .map((line) => line?.trim()).filter(Boolean).join('\n');
}
export const formatShippingAddress = formatAddress;
export function defaultAddress(addresses: readonly Address[]): Address | null { return addresses.find((address) => address.isDefault) ?? null; }

export type ShippingAddress = Readonly<{
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}>;

export type ShippingQuote = Readonly<{
  service: string;
  amountCents: number;
  estimatedDays: number;
}>;

export type ShippingLabel = Readonly<{
  trackingNumber: string;
  labelUrl: string;
}>;

export type PurchaseLabelRequest = Readonly<{
  shipmentId: string;
  service: string;
  shipTo: ShippingAddress;
}>;

export interface ShippingProvider {
  validateAddress(address: ShippingAddress): Promise<boolean>;
  quote(address: ShippingAddress): Promise<readonly ShippingQuote[]>;
  purchaseLabel(request: PurchaseLabelRequest): Promise<ShippingLabel>;
}

export class MockShippingProvider implements ShippingProvider {
  private nextTrackingNumber = 1;

  async validateAddress(address: ShippingAddress): Promise<boolean> {
    return Boolean(address.name && address.line1 && address.city && address.region && address.postalCode && address.countryCode);
  }

  async quote(address: ShippingAddress): Promise<readonly ShippingQuote[]> {
    if (!(await this.validateAddress(address))) return [];
    return [
      { service: 'mock-ground', amountCents: 799, estimatedDays: 5 },
      { service: 'mock-express', amountCents: 1599, estimatedDays: 2 },
    ];
  }

  async purchaseLabel(request: PurchaseLabelRequest): Promise<ShippingLabel> {
    if (!request.shipmentId || !request.service || !(await this.validateAddress(request.shipTo))) {
      throw new TypeError('A shipment, service, and valid destination are required');
    }
    const trackingNumber = `MOCK${String(this.nextTrackingNumber++).padStart(10, '0')}`;
    return { trackingNumber, labelUrl: `https://mock-shipping.invalid/labels/${trackingNumber}.pdf` };
  }
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const CUSTOMER_ORDERS_DEFAULT_LIMIT = 20;
export const CUSTOMER_ORDERS_MAX_LIMIT = 50;
export const CUSTOMER_ORDERS_CURSOR_MAX = 200;

export class ListCustomerOrdersQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: CUSTOMER_ORDERS_MAX_LIMIT, default: CUSTOMER_ORDERS_DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CUSTOMER_ORDERS_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque value from a previous nextCursor.', maxLength: CUSTOMER_ORDERS_CURSOR_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(CUSTOMER_ORDERS_CURSOR_MAX)
  cursor?: string;
}

/** Customer-facing shapes (docs/api/commerce-contract.md section 4). Key sets are exact; tests pin them. */
export interface CustomerOrderSummary {
  id: string;
  status: string;
  totalCents: number;
  subtotalCents: number | null;
  shippingCents: number;
  taxCents: number;
  currency: string;
  createdAt: string;
  itemCount: number;
  carrier: string | null;
  trackingNumber: string | null;
}

export interface CustomerOrderPage {
  items: CustomerOrderSummary[];
  nextCursor: string | null;
}

export interface CustomerOrderItem {
  productId: string;
  slug: string | null;
  name: string;
  lotCode: string;
  quantity: number;
  unitCents: number;
}

export interface CustomerShipment {
  carrier: string;
  trackingNumber: string;
  trackingUrl: string | null;
  shippedAt: string;
  deliveredAt: string | null;
}

export interface CustomerTimelineEntry {
  status: string;
  at: string;
}

export interface CustomerOrderDetail {
  id: string;
  status: string;
  totalCents: number;
  subtotalCents: number | null;
  shippingCents: number;
  taxCents: number;
  currency: string;
  createdAt: string;
  shippingAddress: string | null;
  items: CustomerOrderItem[];
  shipments: CustomerShipment[];
  timeline: CustomerTimelineEntry[];
}

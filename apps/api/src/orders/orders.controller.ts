import { BadRequestException, Body, Controller, Header, Headers, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiHeader,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsBoolean, IsEmail, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import type { IdentityRequest } from '../wallet/customer-identity';
import { resolveOrderIdentity } from './order-identity';
import { MAX_ORDER_LINES, MAX_QUANTITY_PER_LINE, MAX_SHIPPING_ADDRESS_LENGTH, OrdersService } from './orders.service';

class ApiErrorResponse {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Unavailable product in order' })
  message!: string | string[];

  @ApiProperty({ example: 'Bad Request' })
  error!: string;
}

class CreateOrderItem {
  @ApiProperty({ description: 'Catalog product ID.', example: 'cm6k9cwc80000w38zpi4i1s9l' })
  @IsString()
  productId!: string;

  @ApiProperty({ description: 'Released lot code belonging to the selected product.', example: 'BPC-157-2025-01' })
  @IsString()
  lotCode!: string;

  @ApiProperty({ description: `Whole-number quantity to order (1-${MAX_QUANTITY_PER_LINE} per line).`, example: 2, minimum: 1, maximum: MAX_QUANTITY_PER_LINE, format: 'int32' })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY_PER_LINE)
  quantity!: number;
}

class CreateOrder {
  @ApiPropertyOptional({
    description:
      'Email address used to identify the customer. Required for the anonymous development/test flow. With a signed-in customer it may be omitted, and when present it must equal the account email (otherwise 400).',
    example: 'researcher@example.com',
    format: 'email',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  email?: string;

  @ApiProperty({
    description: 'Shipping address as free text. Stored (trimmed) so the order can be shipped; never returned by this public API.',
    example: '123 Research Way, Boston, MA 02110, US',
    minLength: 1,
    maxLength: MAX_SHIPPING_ADDRESS_LENGTH,
  })
  @IsString()
  shippingAddress!: string;

  @ApiProperty({ description: `Between 1 and ${MAX_ORDER_LINES} product/lot lines.`, type: () => [CreateOrderItem], minItems: 1, maxItems: MAX_ORDER_LINES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItem)
  items!: CreateOrderItem[];

  @ApiProperty({
    description: 'Required confirmation that products are being purchased for research use only.',
    example: true,
  })
  @IsBoolean()
  @Equals(true, { message: 'researchUseAcknowledged must be true' })
  researchUseAcknowledged!: boolean;

  @ApiPropertyOptional({
    description: 'Idempotency key. Supply this value here or in the Idempotency-Key header; if both are supplied, they must match.',
    example: 'order-20250115-5a2f6d8c',
    minLength: 8,
    maxLength: 128,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/)
  idempotencyKey?: string;
}

class QuoteBody {
  @ApiProperty({ description: `Between 1 and ${MAX_ORDER_LINES} product/lot lines.`, type: () => [CreateOrderItem], minItems: 1, maxItems: MAX_ORDER_LINES })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_ORDER_LINES)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItem)
  items!: CreateOrderItem[];
}

class OrderItemResponse {
  @ApiProperty({ example: 'cm6k9d0us0000w3l7wyfzdkx9' })
  id!: string;

  @ApiProperty({ example: 'cm6k9cwc80000w38zpi4i1s9l' })
  productId!: string;

  @ApiProperty({ example: 'BPC-157-2025-01' })
  lotCode!: string;

  @ApiProperty({ example: 2, format: 'int32', minimum: 1 })
  quantity!: number;

  @ApiProperty({ description: 'Unit price captured at order creation in integer USD cents.', example: 12500, format: 'int32', minimum: 0 })
  unitCents!: number;
}

class OrderResponse {
  @ApiProperty({ description: 'Server-generated order ID (cuid). It is NOT the idempotency key.', example: 'cm6k9d0ur0000w3l7kvs2wymu' })
  id!: string;

  @ApiProperty({ example: 'cm6k9d0ur0000w3l7kvs2wymu' })
  customerId!: string;

  @ApiProperty({ enum: ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'], example: 'PENDING_PAYMENT' })
  status!: string;

  @ApiProperty({ description: 'Sum of line prices in integer cents. null only for orders created before totals were stored.', example: 25000, format: 'int32', minimum: 0, nullable: true })
  subtotalCents!: number | null;

  @ApiProperty({ description: 'Shipping charge in integer cents (SHIPPING_FLAT_CENTS, waived above SHIPPING_FREE_OVER_CENTS).', example: 0, format: 'int32', minimum: 0 })
  shippingCents!: number;

  @ApiProperty({ description: 'Flat placeholder tax in integer cents (TAX_RATE_BPS of the subtotal, rounded half-up). Not a tax engine.', example: 0, format: 'int32', minimum: 0 })
  taxCents!: number;

  @ApiProperty({ description: 'subtotalCents + shippingCents + taxCents; never a decimal currency amount.', example: 25000, format: 'int32', minimum: 0 })
  totalCents!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ format: 'date-time', example: '2025-01-15T12:00:00.000Z' })
  researchAcknowledgedAt!: string;

  @ApiProperty({ format: 'date-time', example: '2025-01-15T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ type: () => [OrderItemResponse] })
  items!: OrderItemResponse[];
}

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @ApiOperation({
    summary: 'Create an order from active products and released lots',
    description:
      'Development/test: a signed-in customer (shared identity resolver) owns the order and a different body email is a 400; with no identity the anonymous body email is still accepted there, and any caller can claim any email. ' +
      'Production-like runtimes: a signed-in customer is required (401 otherwise). See docs/api/orders.md. ' +
      'Stock for every line is reserved atomically with the order and held until it is paid or expires (ORDER_HOLD_MINUTES). ' +
      'Idempotency is scoped to (customer, Idempotency-Key): the same key with the same payload returns the original order, ' +
      'the same key with a different payload returns 409, and a key used by another customer is unrelated to this one.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Idempotency key. Required unless idempotencyKey is provided in the request body; matching values are required when both are present.',
    schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$' },
  })
  @ApiCreatedResponse({ description: 'Order created, or the order this customer previously created with the same idempotency key and payload.', type: OrderResponse })
  @ApiConflictResponse({
    description:
      'The idempotency key was already used by this customer with a different request, OR (code OUT_OF_STOCK, with productId and available) a line cannot be covered by current stock; nothing is reserved in that case.',
    type: ApiErrorResponse,
  })
  @ApiUnauthorizedResponse({ description: 'Production-like runtimes only: no signed-in customer.' })
  @ApiBadRequestResponse({
    description: 'The request is invalid, omits research-use acknowledgement or an idempotency key, has a blank shipping address or one over 500 characters, has no items, has more than 50 lines, has a quantity outside 1-1000, has a total above the 32-bit cents limit, references an inactive or unavailable product, or assigns a lot to the wrong product.',
    type: ApiErrorResponse,
  })
  create(@Body() body: CreateOrder, @Req() req: IdentityRequest, @Headers('idempotency-key') headerKey?: string | string[]) {
    const idempotencyKey = this.resolveIdempotencyKey(body.idempotencyKey, headerKey);
    const identity = resolveOrderIdentity(req);
    return this.orders.create({ ...body, idempotencyKey, identity });
  }

  @Post('quote')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Price preview for a cart: lines, subtotal, shipping, tax, total, and which lines are unavailable',
    description:
      'Public and rate limited. Reserves nothing and writes nothing. Lines for an active product and known lot are priced even when stock is short (they are then listed in `unavailable` as out_of_stock with the units left); ' +
      'inactive/unknown products and unknown lots are not priced. Tax is a flat placeholder rate, not a tax engine; see docs/api/inventory-and-totals.md.',
  })
  @ApiOkResponse({ description: '{ currency, subtotalCents, shippingCents, taxCents, totalCents, lines[], unavailable[] }' })
  @ApiBadRequestResponse({ description: 'No items, more than 50 lines, a quantity outside 1-1000, or a total above the 32-bit cents limit.', type: ApiErrorResponse })
  quote(@Body() body: QuoteBody) {
    return this.orders.quote(body);
  }

  private resolveIdempotencyKey(bodyKey?: string, headerKey?: string | string[]): string {
    if (Array.isArray(headerKey)) {
      throw new BadRequestException('Idempotency-Key header must be supplied once');
    }
    if (bodyKey && headerKey && bodyKey !== headerKey) {
      throw new BadRequestException('Idempotency key in the header and body must match');
    }
    const idempotencyKey = headerKey ?? bodyKey;
    if (!idempotencyKey) {
      throw new BadRequestException('An idempotency key is required');
    }
    return idempotencyKey;
  }
}

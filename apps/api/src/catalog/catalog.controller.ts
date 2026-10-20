import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { CatalogService } from './catalog.service';

class ApiErrorResponse {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({ example: 'Product not found' })
  message!: string;

  @ApiProperty({ example: 'Not Found' })
  error!: string;
}

class CatalogLotResponse {
  @ApiProperty({ example: 'cm6k9cwc90000w38z4p8qpk0f' })
  id!: string;

  @ApiProperty({ example: 'BPC-157-2025-01' })
  code!: string;

  @ApiProperty({ example: 'cm6k9cwc80000w38zpi4i1s9l' })
  productId!: string;

  @ApiProperty({ description: 'Object-storage key for this lot\'s certificate of analysis.', example: 'coa/BPC-157-2025-01.pdf' })
  coaKey!: string;

  @ApiProperty({ description: 'Lot purity percentage, represented as a decimal string to preserve precision.', example: '98.50' })
  purity!: string;

  @ApiProperty({ format: 'date-time', example: '2025-01-15T00:00:00.000Z' })
  releasedAt!: string;
}

class CatalogProductResponse {
  @ApiProperty({ example: 'cm6k9cwc80000w38zpi4i1s9l' })
  id!: string;

  @ApiProperty({ example: 'BPC-157-5MG' })
  sku!: string;

  @ApiProperty({ example: 'bpc-157-5mg' })
  slug!: string;

  @ApiProperty({ example: 'BPC-157, 5 mg' })
  name!: string;

  @ApiProperty({ description: 'Catalog visibility status. Products returned by these endpoints are active.', example: true })
  active!: boolean;

  @ApiProperty({ description: 'Unit price in integer USD cents; never a decimal currency amount.', example: 12500, format: 'int32', minimum: 0 })
  priceCents!: number;

  @ApiProperty({ description: 'Available inventory count.', example: 24, format: 'int32', minimum: 0 })
  inventory!: number;

  @ApiProperty({ type: () => [CatalogLotResponse] })
  lots!: CatalogLotResponse[];
}

@ApiTags('catalog')
@Controller('products')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @ApiOperation({ summary: 'List active catalog products' })
  @ApiOkResponse({ description: 'Active products and their released lots.', type: CatalogProductResponse, isArray: true })
  list() {
    return this.catalog.list();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a catalog product by slug' })
  @ApiParam({ name: 'slug', description: 'URL-safe product identifier.', example: 'bpc-157-5mg' })
  @ApiOkResponse({ description: 'The product and its lots.', type: CatalogProductResponse })
  @ApiNotFoundResponse({ description: 'No product exists for the supplied slug.', type: ApiErrorResponse })
  one(@Param('slug') slug: string) {
    return this.catalog.one(slug);
  }
}

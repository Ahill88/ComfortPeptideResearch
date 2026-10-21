import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminSessionGuard } from '../admin-session.guard';
import { AdminRoles, CurrentAdmin, RequestIp } from '../admin.decorators';
import type { AdminPrincipal } from '../admin.types';
import { AdjustStockBody, LedgerQuery, ListInventoryQuery, SetThresholdBody } from './admin-inventory.dto';
import { AdminInventoryService } from './admin-inventory.service';

const NO_STORE = () => Header('Cache-Control', 'no-store');
const actorOf = (admin: AdminPrincipal, ip: string | null) => ({ id: admin.id, ip });

/** Back-office stock levels. Every route requires a valid admin session; only the threshold needs OWNER. */
@ApiTags('admin-inventory')
@ApiHeader({ name: 'Authorization', required: true, description: 'Bearer <admin session token>.' })
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked admin session.' })
@UseGuards(AdminSessionGuard)
@Controller('admin/inventory')
export class AdminInventoryController {
  constructor(private readonly inventory: AdminInventoryService) {}

  @Get()
  @NO_STORE()
  @ApiOperation({ summary: 'Stock per product (SKU order, keyset pagination): onHand, reserved, lowStockThreshold, lowStock.' })
  @ApiOkResponse({ description: '{ items: AdminInventoryItem[], nextCursor: string | null }' })
  @ApiBadRequestResponse({ description: 'Invalid cursor, limit outside 1-100, or a non-boolean lowStockOnly.' })
  list(@Query() query: ListInventoryQuery) {
    return this.inventory.list(query);
  }

  @Post(':productId/adjust')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'Add or remove stock by hand (one ledger row, one audit event). The result may not go below 0.' })
  @ApiOkResponse({ description: 'Updated AdminInventoryItem.' })
  @ApiBadRequestResponse({ description: 'delta is 0, not a whole number or beyond +-100000; reason missing or over 200 characters.' })
  @ApiNotFoundResponse({ description: 'Unknown product.' })
  @ApiConflictResponse({ description: 'The adjustment would take stock below zero.' })
  adjust(@Param('productId') productId: string, @Body() body: AdjustStockBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.inventory.adjust(productId, body, actorOf(admin, ip));
  }

  @Get(':productId/ledger')
  @NO_STORE()
  @ApiOperation({ summary: 'Stock movements for a product, newest first (keyset pagination by createdAt then id).' })
  @ApiOkResponse({ description: '{ items: [{ id, delta, kind, reason, orderId, adminName, createdAt }], nextCursor }' })
  @ApiBadRequestResponse({ description: 'Invalid cursor or limit outside 1-100.' })
  @ApiNotFoundResponse({ description: 'Unknown product.' })
  ledger(@Param('productId') productId: string, @Query() query: LedgerQuery) {
    return this.inventory.ledger(productId, query);
  }

  @Post(':productId/threshold')
  @HttpCode(200)
  @NO_STORE()
  @AdminRoles('OWNER')
  @ApiOperation({ summary: 'Set (or clear with null) the low-stock threshold. OWNER only.' })
  @ApiOkResponse({ description: 'Updated AdminInventoryItem.' })
  @ApiForbiddenResponse({ description: 'Not an OWNER.' })
  @ApiBadRequestResponse({ description: 'lowStockThreshold is not a whole number >= 0 or null.' })
  @ApiNotFoundResponse({ description: 'Unknown product.' })
  threshold(@Param('productId') productId: string, @Body() body: SetThresholdBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.inventory.setThreshold(productId, body.lowStockThreshold, actorOf(admin, ip));
  }
}

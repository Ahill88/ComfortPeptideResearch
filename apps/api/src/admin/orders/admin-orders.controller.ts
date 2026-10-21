import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminSessionGuard } from '../admin-session.guard';
import { CurrentAdmin, RequestIp } from '../admin.decorators';
import type { AdminPrincipal } from '../admin.types';
import { AddOrderNoteBody, CancelOrderBody, ListAdminOrdersQuery, ShipOrderBody } from './admin-orders.dto';
import { AdminOrdersService } from './admin-orders.service';
import { PAID_ORDER_CANCEL_MESSAGE } from './admin-orders.types';

const NO_STORE = () => Header('Cache-Control', 'no-store');
const actorOf = (admin: AdminPrincipal, ip: string | null) => ({ id: admin.id, ip });

/**
 * Back-office order fulfillment (owner packs and ships personally). Every route requires a valid admin session.
 * Nothing here can change payment or money state: no PAID transition, no refunds, no inventory change.
 */
@ApiTags('admin-orders')
@ApiHeader({ name: 'Authorization', required: true, description: 'Bearer <admin session token>.' })
@ApiUnauthorizedResponse({ description: 'Missing, invalid, expired or revoked admin session.' })
@UseGuards(AdminSessionGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get('counts')
  @NO_STORE()
  @ApiOperation({ summary: 'Order count per status (all seven statuses, zero-filled).' })
  @ApiOkResponse({ description: '{ counts: { PENDING_PAYMENT, PAID, PROCESSING, SHIPPED, DELIVERED, CANCELLED, REFUNDED } }' })
  counts() {
    return this.orders.counts();
  }

  @Get()
  @NO_STORE()
  @ApiOperation({ summary: 'List orders newest first (keyset pagination by createdAt then id).' })
  @ApiOkResponse({ description: '{ items: AdminOrderSummary[], nextCursor: string | null }' })
  @ApiBadRequestResponse({ description: 'Unknown status, invalid cursor, or limit outside 1-100.' })
  list(@Query() query: ListAdminOrdersQuery) {
    return this.orders.list(query);
  }

  @Get(':id')
  @NO_STORE()
  @ApiOperation({ summary: 'Order detail: items, shipping address, payment summary, shipments, events, allowed actions.' })
  @ApiOkResponse({ description: 'AdminOrderDetail' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  detail(@Param('id') id: string) {
    return this.orders.detail(id);
  }

  @Post(':id/start-packing')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'PAID -> PROCESSING.' })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail.' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  @ApiConflictResponse({ description: 'Order is not PAID.' })
  startPacking(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.orders.startPacking(id, actorOf(admin, ip));
  }

  @Post(':id/ship')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'PROCESSING -> SHIPPED and record the shipment (carrier + tracking number).' })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail.' })
  @ApiBadRequestResponse({ description: 'Invalid carrier or tracking number.' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  @ApiConflictResponse({ description: 'Order is not PROCESSING, or the tracking number is already recorded for this order.' })
  ship(@Param('id') id: string, @Body() body: ShipOrderBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.orders.ship(id, body, actorOf(admin, ip));
  }

  @Post(':id/mark-delivered')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'SHIPPED -> DELIVERED (sets deliveredAt on the order shipments).' })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail.' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  @ApiConflictResponse({ description: 'Order is not SHIPPED.' })
  markDelivered(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.orders.markDelivered(id, actorOf(admin, ip));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'PENDING_PAYMENT -> CANCELLED only.', description: PAID_ORDER_CANCEL_MESSAGE })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail.' })
  @ApiBadRequestResponse({ description: 'Missing or over-long reason.' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  @ApiConflictResponse({ description: `Order is not PENDING_PAYMENT. PAID, PROCESSING and SHIPPED orders: "${PAID_ORDER_CANCEL_MESSAGE}"` })
  cancel(@Param('id') id: string, @Body() body: CancelOrderBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.orders.cancel(id, body.reason, actorOf(admin, ip));
  }

  @Post(':id/notes')
  @HttpCode(200)
  @NO_STORE()
  @ApiOperation({ summary: 'Add a staff note to the order history (any status).' })
  @ApiOkResponse({ description: 'Updated AdminOrderDetail.' })
  @ApiBadRequestResponse({ description: 'Missing or over-long note.' })
  @ApiNotFoundResponse({ description: 'Unknown order id.' })
  addNote(@Param('id') id: string, @Body() body: AddOrderNoteBody, @CurrentAdmin() admin: AdminPrincipal, @RequestIp() ip: string | null) {
    return this.orders.addNote(id, body.note, actorOf(admin, ip));
  }
}

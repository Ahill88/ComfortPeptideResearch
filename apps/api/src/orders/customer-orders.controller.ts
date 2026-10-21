import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiHeader, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { CustomerEmail } from '../wallet/customer-identity';
import { ListCustomerOrdersQuery } from './customer-orders.dto';
import { CustomerOrdersService } from './customer-orders.service';

/**
 * Same path prefix as OrdersController (`/v1/orders`). Only GET handlers live here, and the other controller owns
 * `POST /orders` and `POST /orders/quote`: Express routes by method + path, so `GET /orders/:id` can never capture them.
 */
@ApiTags('orders')
@ApiHeader({ name: 'x-customer-email', required: false, description: 'Development/test identity header; a signed-in session cookie is used otherwise (see the shared customer identity resolver).' })
@ApiUnauthorizedResponse({ description: 'No customer identity.' })
@Controller('orders')
export class CustomerOrdersController {
  constructor(private readonly orders: CustomerOrdersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'My orders, newest first (keyset pagination by createdAt then id).' })
  @ApiOkResponse({ description: '{ items: CustomerOrderSummary[], nextCursor: string | null }' })
  @ApiBadRequestResponse({ description: 'limit outside 1-50 or an invalid cursor.' })
  list(@CustomerEmail() email: string, @Query() query: ListCustomerOrdersQuery) {
    return this.orders.list(email, query);
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'One of my orders. Someone else’s order id is a 404, exactly like an unknown id.' })
  @ApiOkResponse({ description: 'CustomerOrderDetail' })
  @ApiNotFoundResponse({ description: 'Unknown order id, or an order that belongs to another customer.' })
  detail(@CustomerEmail() email: string, @Param('id') id: string) {
    return this.orders.detail(email, id);
  }
}

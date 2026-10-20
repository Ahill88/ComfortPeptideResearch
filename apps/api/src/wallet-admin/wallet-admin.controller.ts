import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminTokenGuard } from './admin-token.guard';
import { FundingQuery, PageQuery, PaymentIntentsQuery, SettlementsQuery, TransactionsQuery } from './wallet-admin.dto';
import { BALANCE_LABEL, WalletAdminService } from './wallet-admin.service';

/**
 * READ-ONLY administrative reporting over the user-owned wallet domain.
 *
 * Administrators CANNOT control customer wallets. This controller:
 *  - exposes GET handlers only (no POST/PUT/PATCH/DELETE),
 *  - accepts no wallet address or amount as input and moves no funds,
 *  - never signs, never holds keys, and never calls the chain,
 *  - reports balances only as display values observed on chain; they are not platform-held balances.
 *
 * Access requires the `x-admin-token` header to equal the server's ADMIN_API_TOKEN.
 * If ADMIN_API_TOKEN is unset, every request is denied (fail closed).
 */
@ApiTags('wallet-admin')
@ApiHeader({ name: 'x-admin-token', required: true, description: 'Must equal the server ADMIN_API_TOKEN. All requests are denied when it is unset.' })
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin token, or ADMIN_API_TOKEN is not configured.' })
@UseGuards(AdminTokenGuard)
@Controller('admin/wallets')
export class WalletAdminController {
  constructor(private readonly service: WalletAdminService) {}

  @Get('directory')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Wallet directory: customer email, provider, network, created date.' })
  @ApiOkResponse({ description: 'Page of customer wallets (read-only).' })
  directory(@Query() query: PageQuery) {
    return this.service.directory(query.take, query.cursor);
  }

  @Get('balances')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Latest observed balance snapshot per wallet.', description: `Label: ${BALANCE_LABEL}.` })
  @ApiOkResponse({ description: 'Exact USDC string and floor Research Credits per wallet; amounts as strings.' })
  balances(@Query() query: PageQuery) {
    return this.service.balances(query.take, query.cursor);
  }

  @Get('funding')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'On-ramp funding intents and their status.' })
  @ApiOkResponse({ description: 'Page of on-ramp intents.' })
  funding(@Query() query: FundingQuery) {
    return this.service.funding(query.take, query.cursor, query.status);
  }

  @Get('payment-intents')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Payment rows and PURCHASE crypto transactions.' })
  @ApiOkResponse({ description: 'Two independently paginated lists.' })
  paymentIntents(@Query() query: PaymentIntentsQuery) {
    return this.service.paymentIntents(query.take, query.paymentsCursor, query.purchasesCursor);
  }

  @Get('transactions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'On-chain verification: crypto transactions, filterable by status.' })
  @ApiOkResponse({ description: 'Page of crypto transactions.' })
  transactions(@Query() query: TransactionsQuery) {
    return this.service.transactions(query.take, query.cursor, query.status);
  }

  @Get('failed')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'FAILED and EXPIRED crypto transactions with failure reason.' })
  @ApiOkResponse({ description: 'Page of failed or expired transactions.' })
  failed(@Query() query: PageQuery) {
    return this.service.failed(query.take, query.cursor);
  }

  @Get('pending-orders')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Orders awaiting payment (PENDING_PAYMENT).' })
  @ApiOkResponse({ description: 'Page of pending orders.' })
  pendingOrders(@Query() query: PageQuery) {
    return this.service.pendingOrders(query.take, query.cursor);
  }

  @Get('settlements')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'FINALIZED PURCHASE rows aggregated per UTC day.' })
  @ApiOkResponse({ description: 'Per-day count and total atomic USDC as strings, plus all-time totals.' })
  settlements(@Query() query: SettlementsQuery) {
    return this.service.settlements(query.take, query.cursor);
  }

  @Get('reconciliation')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Counts per CryptoTxStatus and age of the oldest SUBMITTED transaction.' })
  @ApiOkResponse({ description: 'Reconciliation summary.' })
  reconciliation() {
    return this.service.reconciliation();
  }

  @Get('providers')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Provider and feature-flag status. Never returns secret values.' })
  @ApiOkResponse({ description: 'Static provider status derived from environment presence checks.' })
  providers() {
    return this.service.providers();
  }
}

import { Body, Controller, Param, Post, Get, Req, UseFilters, UseGuards, UseInterceptors, HttpCode } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreditsService } from './credits.service';
import { CustomerEmail } from './customer-identity';
import { OnRampService } from './onramp/onramp.service';
import { OrderTopUpService } from './onramp/order-topup.service';
import { TransfersService } from './transfers/transfers.service';
import { AssociateWalletDto, CreateOnRampDto, LinkChallengeDto, OrderTopUpDto, PrepareTransferDto, SubmitTransferDto } from './wallet.dto';
import { BigIntSerializerInterceptor, ChainErrorFilter, NoSecretMaterialGuard } from './wallet.http';
import { WalletService } from './wallet.service';

const IDENTITY_HEADER = {
  name: 'x-customer-email',
  required: true,
  description: 'SANDBOX identity only: honored when NODE_ENV is not "production". In production every request is 401 until real authentication is implemented.',
};

@ApiTags('wallet')
@ApiHeader(IDENTITY_HEADER)
@Controller('wallet')
@UseGuards(NoSecretMaterialGuard)
@UseInterceptors(BigIntSerializerInterceptor)
@UseFilters(ChainErrorFilter)
export class WalletController {
  constructor(
    private readonly wallets: WalletService,
    private readonly credits: CreditsService,
    private readonly onRamp: OnRampService,
    private readonly topUps: OrderTopUpService,
    private readonly transfers: TransfersService,
  ) {}

  @Post('link-challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Step 1 of linking a wallet: returns a 5 minute challenge. Sign `message` with the wallet that owns the address, then POST /v1/wallet with the challenge and signature.' })
  @ApiResponse({ status: 400, description: 'Invalid address or secret-looking fields.' })
  linkChallenge(@CustomerEmail() email: string, @Body() body: LinkChallengeDto) {
    return this.wallets.createLinkChallenge(email, body);
  }

  @Post()
  @ApiOperation({ summary: 'Step 2: link a customer-owned wallet by public address with proof of key control (ed25519 signature of the link challenge). Idempotent; one wallet per customer.' })
  @ApiResponse({ status: 400, description: 'Invalid address, secret-looking fields, unconfigured provider, or "Unable to link this wallet" (invalid/expired proof or address unavailable; deliberately not distinguished).' })
  @ApiResponse({ status: 409, description: 'A different wallet is already linked to this account.' })
  async associate(@CustomerEmail() email: string, @Body() body: AssociateWalletDto) {
    const { wallet, provider } = await this.wallets.associateWallet(email, body);
    return { wallet, provider };
  }

  @Get()
  @ApiOperation({ summary: 'Get the linked wallet and its provider disclosure.' })
  getWallet(@CustomerEmail() email: string) {
    return this.wallets.getWallet(email);
  }

  @Get('balance')
  @ApiOperation({ summary: 'Derived Research Credits balance (finalized chain balance minus pending outgoing and reservations). Amounts are decimal strings of USDC base units; stale:true means spendable is 0 (fail closed).' })
  async balance(@CustomerEmail() email: string) {
    const customer = await this.wallets.resolveCustomer(email);
    await this.transfers.reconcile(customer.id);
    return this.credits.getBalance(customer.id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'List wallet transactions (deposits, withdrawals, purchases).' })
  async transactions(@CustomerEmail() email: string) {
    const customer = await this.wallets.resolveCustomer(email);
    await this.transfers.reconcile(customer.id);
    return { transactions: await this.credits.listTransactions(customer.id) };
  }

  @Post('onramp')
  @ApiOperation({ summary: 'Create an on-ramp intent. Destination is always your own linked wallet. Without ENABLE_REAL_MOONPAY this is a clearly labeled sandbox quote.' })
  async createOnRamp(@CustomerEmail() email: string, @Body() body: CreateOnRampDto, @Req() req: { ip?: string }) {
    const customer = await this.wallets.resolveCustomer(email);
    return this.onRamp.createIntent(customer.id, { intendedUsdCents: body.amountUsdCents, customerIp: req.ip });
  }

  @Post('onramp/order-topup')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Checkout shortfall. Computes how much spendable USDC your pending order is missing and, if short, opens an on-ramp intent for at least that amount (whole US dollars, plus an operator-set fee buffer). Funds land in your own linked wallet; nothing is paid or credited here, and balances come only from the chain. Amounts are decimal strings of USDC base units.',
  })
  @ApiResponse({ status: 400, description: 'Needed amount exceeds the maximum single purchase.' })
  @ApiResponse({ status: 403, description: 'Eligibility not approved.' })
  @ApiResponse({ status: 404, description: 'Order not found (also for orders owned by someone else).' })
  @ApiResponse({ status: 409, description: 'Order is not awaiting payment, payment already in flight, or no wallet linked.' })
  @ApiResponse({ status: 503, description: 'Balance could not be read from the chain; nothing was created.' })
  async orderTopUp(@CustomerEmail() email: string, @Body() body: OrderTopUpDto, @Req() req: { ip?: string }) {
    const customer = await this.wallets.resolveCustomer(email);
    return this.topUps.topUpForOrder(customer.id, body.orderId, req.ip);
  }

  @Post('onramp/:id/mock-complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'SANDBOX ONLY: simulate a completed on-ramp by crediting the in-memory sandbox chain. 403 outside WALLET_CHAIN_MODE=sandbox or in production.' })
  async mockComplete(@CustomerEmail() email: string, @Param('id') id: string) {
    const customer = await this.wallets.resolveCustomer(email);
    return this.onRamp.mockComplete(customer.id, id);
  }

  @Post('transfers/prepare')
  @ApiOperation({ summary: 'Build an UNSIGNED USDC transfer transaction for your wallet to sign. The platform never signs.' })
  async prepareTransfer(@CustomerEmail() email: string, @Body() body: PrepareTransferDto) {
    const customer = await this.wallets.resolveCustomer(email);
    return this.transfers.prepare(customer.id, body);
  }

  @Post('transfers/:id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit the transaction signed by your wallet. Must match the prepared message exactly. Idempotent for the same signed payload.' })
  async submitTransfer(@CustomerEmail() email: string, @Param('id') id: string, @Body() body: SubmitTransferDto) {
    const customer = await this.wallets.resolveCustomer(email);
    return this.transfers.submit(customer.id, id, body.signedTransaction);
  }
}

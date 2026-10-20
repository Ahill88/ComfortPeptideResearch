import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CUSTOMER_EMAIL_HEADER, resolveHeaderCustomer } from '../customer-identity';
import { CheckoutService } from './checkout.service';
import {
  CheckoutErrorResponse,
  CheckoutStatusResponse,
  PrepareCheckoutResponse,
  SubmitCheckoutDto,
  SubmitCheckoutResponse,
} from './checkout.dto';

/**
 * Identity: until a real auth guard is wired by the lead, the customer is taken from the
 * `x-customer-email` header, honored ONLY when NODE_ENV is exactly "development" or "test"
 * (allowlist, see ../customer-identity). Every other runtime (production, unset, staging, ...) is
 * rejected with 401 (fail closed).
 */
@ApiTags('wallet-checkout')
@ApiHeader({ name: 'x-customer-email', required: false, description: 'Development/test runtimes only (NODE_ENV=development|test). 401 in every other runtime.' })
@ApiUnauthorizedResponse({ type: CheckoutErrorResponse })
@Controller('wallet/checkout')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post(':orderId/prepare')
  @HttpCode(200)
  @ApiOperation({ summary: 'Prepare an unsigned USDC payment for the customer to sign with their own wallet' })
  @ApiOkResponse({ type: PrepareCheckoutResponse })
  @ApiBadRequestResponse({ type: CheckoutErrorResponse })
  @ApiNotFoundResponse({ type: CheckoutErrorResponse })
  @ApiConflictResponse({ type: CheckoutErrorResponse })
  @ApiServiceUnavailableResponse({ type: CheckoutErrorResponse })
  async prepare(@Param('orderId') orderId: string, @Headers('x-customer-email') email?: string | string[]) {
    return this.checkout.prepare(await this.identify(email), orderId);
  }

  @Post(':orderId/submit')
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit the customer-signed transaction for broadcast' })
  @ApiOkResponse({ type: SubmitCheckoutResponse })
  @ApiBadRequestResponse({ description: 'Unsigned, wrongly signed, or altered transaction.', type: CheckoutErrorResponse })
  @ApiNotFoundResponse({ type: CheckoutErrorResponse })
  @ApiConflictResponse({ description: 'Expired reservation or a different payload was already submitted.', type: CheckoutErrorResponse })
  @ApiServiceUnavailableResponse({ type: CheckoutErrorResponse })
  async submit(@Param('orderId') orderId: string, @Body() body: SubmitCheckoutDto, @Headers('x-customer-email') email?: string | string[]) {
    return this.checkout.submit(await this.identify(email), orderId, body.signedTransactionBase64);
  }

  @Get(':orderId/status')
  @ApiOperation({ summary: 'Read-only checkout status for an order' })
  @ApiOkResponse({ type: CheckoutStatusResponse })
  @ApiNotFoundResponse({ type: CheckoutErrorResponse })
  async status(@Param('orderId') orderId: string, @Headers('x-customer-email') email?: string | string[]) {
    return this.checkout.status(await this.identify(email), orderId);
  }

  private async identify(header: string | string[] | undefined): Promise<string> {
    const { customer } = await resolveHeaderCustomer({ [CUSTOMER_EMAIL_HEADER]: header }, (email) => this.checkout.findCustomerIdByEmail(email));
    return customer;
  }
}

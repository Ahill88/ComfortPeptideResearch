import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';
import { PaymentsService } from './payments.service';

class PaymentRequest {
  @ApiProperty({ enum: ['solana-usdc'], description: 'Payment rail for this order.' })
  @IsIn(['solana-usdc'])
  method!: 'solana-usdc';
}

class Confirmation {
  @ApiProperty({
    description: 'Solana transaction reference. Submission requests verification; it never settles a payment directly.',
    example: '5Yv3jS1dSGmHz4B1bYy3hDJxJ7ivUHrb2dny1sy9aPDAZHqj7Qq3YHGG4PBymKFEZ1tZdhuxjG6xTY4MMqE1DX5h',
  })
  @IsString()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
  signature!: string;
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('orders/:orderId/intents')
  intent(@Param('orderId') id: string, @Body() body: PaymentRequest) {
    return this.payments.createIntent(id, body.method);
  }

  @Post(':id/confirmations')
  confirm(@Param('id') id: string, @Body() body: Confirmation) {
    return this.payments.submitConfirmation(id, body.signature);
  }
}

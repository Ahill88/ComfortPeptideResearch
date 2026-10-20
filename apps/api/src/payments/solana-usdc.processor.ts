import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ServiceUnavailableException } from '@nestjs/common';
import { Job } from 'bullmq';

@Processor('payment-confirmation')
export class SolanaUsdcProcessor extends WorkerHost {
  async process(_: Job<{ paymentId: string; signature: string }>): Promise<never> {
    // Do not settle based on a user-provided signature. A future verifier must
    // independently validate network, mint, destination, amount, reference, and finality via RPC.
    throw new ServiceUnavailableException(
      'Live Solana settlement is disabled until exact RPC verification is implemented',
    );
  }
}

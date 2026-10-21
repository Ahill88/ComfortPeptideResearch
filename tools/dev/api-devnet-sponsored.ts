/**
 * LOCAL DEVELOPMENT ONLY: runs the real API (the full AppModule) against Solana DEVNET with a throwaway devnet key bound
 * as the platform's network-fee payer (FEE_PAYER_SIGNER), so a customer wallet with ZERO SOL can pay for an order.
 *
 *   DEV_SPONSOR_KEYPAIR_FILE=/path/to/devnet-sponsor.json \      # JSON array of 64 secret-key bytes; funded devnet key only
 *   NODE_ENV=development pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tools/dev/api-devnet-sponsored.ts
 *
 * Configuration comes from .env exactly like `pnpm dev:api` (WALLET_CHAIN_MODE=devnet, FEE_SPONSORSHIP=true, ...).
 *
 * Why this file is not part of apps/api/src: the API never holds key material (tests/wallet/custody-invariants.test.ts).
 * A production deployment binds a KMS/HSM-backed signer under the same FEE_PAYER_SIGNER token instead; this launcher
 * only demonstrates the binding with a local key. It refuses to start unless every condition below holds:
 *   - NODE_ENV is exactly "development"; WALLET_CHAIN_MODE=devnet on solana-devnet; FEE_SPONSORSHIP=true
 *   - the RPC URL looks like devnet and the database host is local
 * The key is read from the file, is never printed, and can only sign the fee-payer slot of transactions the API itself
 * built and verified (the API asserts the fee payer appears in no instruction before it asks for a signature).
 *
 * OPTIONAL, COA anchoring: DEV_COA_PUBLISHER_KEYPAIR_FILE=/path/to/devnet-coa-publisher.json (a DIFFERENT throwaway devnet key, funded
 * with devnet SOL, see docs/api/coa-anchoring.md) binds COA_PUBLISHER_SIGNER the same way, so publishing a COA writes a real memo to
 * devnet. Requires COA_ANCHOR_ENABLED=true in .env, COA_ANCHOR_NETWORK unset or solana-devnet and a devnet COA_ANCHOR_RPC_URL (or none).
 * Unset => no publisher is bound, anchors stay PENDING with an error, and a note is printed. The same safety checks apply.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const apiRequire = createRequire(path.join(__dirname, '../../apps/api/package.json'));
const { Keypair } = apiRequire('@solana/web3.js') as typeof import('@solana/web3.js');

function fail(message: string): never {
  console.error(`Refusing to start: ${message}`);
  process.exit(1);
}

async function main() {
  // Load .env the way the API does (repo root), before any check reads process.env.
  const dotenv = apiRequire('dotenv') as typeof import('dotenv');
  dotenv.config({ path: path.join(__dirname, '../../.env') });

  const keyFile = process.env.DEV_SPONSOR_KEYPAIR_FILE;
  if (!keyFile) fail('DEV_SPONSOR_KEYPAIR_FILE is required.');
  if (process.env.NODE_ENV !== 'development') fail('NODE_ENV must be exactly "development".');
  if (process.env.WALLET_CHAIN_MODE !== 'devnet' || (process.env.SOLANA_NETWORK ?? 'solana-devnet') !== 'solana-devnet') fail('WALLET_CHAIN_MODE=devnet on solana-devnet is required.');
  if (process.env.FEE_SPONSORSHIP !== 'true') fail('FEE_SPONSORSHIP=true is required.');
  if (!/devnet/i.test(process.env.SOLANA_RPC_URL ?? 'devnet')) fail('SOLANA_RPC_URL must be a devnet endpoint.');
  const database = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
  if (!['127.0.0.1', 'localhost'].includes(database.hostname)) fail('DATABASE_URL must point at a local database.');

  const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile!, 'utf8')) as number[]));
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(sponsor.secretKey.slice(0, 32))]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const feePayerSigner = {
    publicKey: sponsor.publicKey.toBase58(),
    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(crypto.sign(null, Buffer.from(message), privateKey));
    },
  };

  // Optional: a separate throwaway devnet key for COA anchors (never the fee-payer key).
  let coaPublisherSigner: { publicKey: string; signMessage(message: Uint8Array): Promise<Uint8Array> } | undefined;
  const coaKeyFile = process.env.DEV_COA_PUBLISHER_KEYPAIR_FILE?.trim();
  if (coaKeyFile) {
    if (process.env.COA_ANCHOR_ENABLED !== 'true') fail('DEV_COA_PUBLISHER_KEYPAIR_FILE is set, so COA_ANCHOR_ENABLED=true is required in .env.');
    if ((process.env.COA_ANCHOR_NETWORK ?? 'solana-devnet') !== 'solana-devnet') fail('COA anchoring must use COA_ANCHOR_NETWORK=solana-devnet with the dev launcher.');
    if (!/devnet|localhost|127\.0\.0\.1/i.test(process.env.COA_ANCHOR_RPC_URL ?? 'devnet')) fail('COA_ANCHOR_RPC_URL must be a devnet endpoint.');
    const publisher = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(coaKeyFile, 'utf8')) as number[]));
    if (publisher.publicKey.equals(sponsor.publicKey)) fail('DEV_COA_PUBLISHER_KEYPAIR_FILE must be a different key than DEV_SPONSOR_KEYPAIR_FILE.');
    const publisherPkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(publisher.secretKey.slice(0, 32))]);
    const publisherKey = crypto.createPrivateKey({ key: publisherPkcs8, format: 'der', type: 'pkcs8' });
    coaPublisherSigner = {
      publicKey: publisher.publicKey.toBase58(),
      async signMessage(message: Uint8Array): Promise<Uint8Array> {
        return new Uint8Array(crypto.sign(null, Buffer.from(message), publisherKey));
      },
    };
  } else {
    console.log('Note: DEV_COA_PUBLISHER_KEYPAIR_FILE is not set; no COA publisher is bound, so COA anchors will stay PENDING ("no publisher signer is bound").');
  }

  const { Logger, ValidationPipe } = await import('@nestjs/common');
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../../apps/api/src/app.module');
  const { FEE_PAYER_SIGNER } = await import('../../apps/api/src/wallet/checkout/ports');
  const { COA_PUBLISHER_SIGNER } = await import('../../apps/api/src/coa/anchor/coa-publisher-signer.port');
  const { configureApp } = await import('../../apps/api/src/config/configure-app');
  const { assertValidEnv } = await import('../../apps/api/src/config/env.validation');
  const { HEALTH_PREFIX_EXCLUDE } = await import('../../apps/api/src/health/health.module');

  const logger = new Logger('DevnetSponsoredLauncher');
  for (const warning of assertValidEnv(process.env)) logger.warn(warning);

  const builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(FEE_PAYER_SIGNER).useValue(feePayerSigner);
  if (coaPublisherSigner) builder.overrideProvider(COA_PUBLISHER_SIGNER).useValue(coaPublisherSigner);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<import('@nestjs/platform-express').NestExpressApplication>();
  app.setGlobalPrefix('v1', { exclude: HEALTH_PREFIX_EXCLUDE });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  configureApp(app, process.env);
  const port = Number(process.env.PORT?.trim() || 3001);
  await app.listen(port);
  // console, not Nest's Logger: the testing harness silences Nest logs below error level.
  console.log(`API listening on :${port} on Solana devnet; network fees are paid by the dev sponsor ${feePayerSigner.publicKey}`);
  if (coaPublisherSigner) console.log(`COA anchors are written to devnet by the dev publisher ${coaPublisherSigner.publicKey} (fund it with devnet SOL: docs/api/coa-anchoring.md)`);
}

main().catch((error: unknown) => {
  console.error('Launcher failed', error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * MANUAL LIVE DEVNET RUN (not part of tests/run-all.mjs: the file name does not end in .test.ts).
 *
 * Anchors ONE fake lot ('LIVE-TEST-1') on Solana DEVNET through the real AnchorService and the real SolanaCoaAnchorChain, then waits for the
 * real verifier (finalized read-back of the transaction) to mark it CONFIRMED. The database is an in-memory double: nothing is written to
 * Postgres. Public-RPC rate limits apply; the run sends exactly one transaction and polls with a bounded number of requests.
 *
 *   DEV_COA_PUBLISHER_KEYPAIR_FILE=/path/to/throwaway-devnet-key.json \   # JSON array of 64 bytes; funded devnet key only
 *   pnpm --dir apps/api exec ts-node --project tsconfig.json --transpile-only ../../tests/coa/live-anchor.run.ts
 *
 * The key is read from the file, never printed, and signs only the memo-only anchor message (assertMemoOnlyMessage runs first).
 */
import { createHash, createPrivateKey, sign as ed25519Detached } from 'node:crypto';
import * as fs from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { Logger } from '@nestjs/common';
import { AnchorService } from '../../apps/api/src/coa/anchor/anchor.service';
import { loadCoaAnchorConfig } from '../../apps/api/src/coa/anchor/coa-anchor.config';
import { SolanaCoaAnchorChain } from '../../apps/api/src/coa/anchor/coa-anchor-chain';
import { FakePrisma } from './_anchor-helpers';

const keyFile = process.env.DEV_COA_PUBLISHER_KEYPAIR_FILE;
if (!keyFile) throw new Error('DEV_COA_PUBLISHER_KEYPAIR_FILE is required (a throwaway, devnet-funded key).');
const config = loadCoaAnchorConfig({ COA_ANCHOR_ENABLED: 'true', COA_ANCHOR_NETWORK: 'solana-devnet', COA_ANCHOR_RPC_URL: process.env.COA_ANCHOR_RPC_URL });
if (!/devnet/i.test(config.rpcUrl)) throw new Error('Refusing to run: the RPC URL is not a devnet endpoint.');

async function main() {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile!, 'utf8')) as number[]));
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.slice(0, 32))]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const signer = {
    publicKey: keypair.publicKey.toBase58(),
    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(ed25519Detached(null, Buffer.from(message), privateKey));
    },
  };

  const prisma = new FakePrisma();
  const lot = prisma.addLot('LIVE-TEST-1');
  const sha = createHash('sha256').update('LIVE-TEST-1 fake certificate of analysis').digest('hex');
  const coa = prisma.addCoa(lot.id, { fileSha256: sha });
  const chain = new SolanaCoaAnchorChain({ network: config.network, rpcUrl: config.rpcUrl });
  const service = new AnchorService(prisma as never, config, chain, signer);
  Logger.overrideLogger(['warn', 'error']);

  console.log(`publisher ${signer.publicKey} on ${config.network}`);
  await service.requestAnchor({ coaId: coa.id, kind: 'PUBLISH' });
  let snapshot = await service.snapshot(coa.id, 'PUBLISH');
  console.log(`requested: status=${snapshot?.status} attempts=${snapshot?.attempts} error=${snapshot?.error ?? '-'}`);
  console.log(`memo      ${snapshot?.memo}`);
  console.log(`signature ${snapshot?.txSignature ?? '(none)'}`);
  if (!snapshot?.txSignature) process.exit(1);

  // Bounded polling: devnet finalizes in roughly 13 to 20 seconds; at most 20 reads over about 100 seconds.
  for (let i = 0; i < 20 && snapshot?.status === 'PENDING'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    snapshot = await service.verifyAnchor(snapshot.id);
    console.log(`  verify #${i + 1}: ${snapshot?.status}${snapshot?.error ? ` (${snapshot.error})` : ''}`);
  }
  console.log(`final: status=${snapshot?.status} slot=${snapshot?.slot} blockTime=${snapshot?.blockTime?.toISOString()}`);
  console.log(`explorer ${snapshot?.explorerUrl}`);
  process.exit(snapshot?.status === 'CONFIRMED' ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('live anchor run failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

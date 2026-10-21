import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import { USDC_DECIMALS } from '../contracts';
import { SOLANA_GENESIS_HASHES, WalletRuntimeConfig } from '../wallet.config';

/** Port the payment paths consult (provided under CHAIN_READINESS_PORT in checkout/ports.ts). */
export interface ChainReadiness {
  isReady(): boolean;
  /** Plain reason for the refusal while not ready; empty when ready. Never contains a URL. */
  reason(): string;
}

export type PreflightState =
  /** Not run yet (before onModuleInit): NOT ready. */
  | 'pending'
  /** Every check passed. */
  | 'passed'
  /** The RPC could not be reached; payments stay closed and the check is retried on a timer. */
  | 'degraded'
  /** A check definitively failed (wrong cluster, wrong mint). Payments stay closed; startup is refused when this happens at boot. */
  | 'failed'
  /** The in-memory sandbox chain has nothing to check. */
  | 'skipped';

/** The subset of Connection the preflight uses, so tests can pass a fake. */
export type PreflightConnection = Pick<Connection, 'getGenesisHash' | 'getAccountInfo'>;

export interface ChainPreflightOptions {
  connection?: PreflightConnection;
  /** Delay between re-checks while degraded. Default 30 s. */
  retryMs?: number;
  /** Per-RPC-call timeout. Default 10 s. */
  callTimeoutMs?: number;
}

/** A check that definitively failed: the configuration is wrong, retrying cannot help. */
export class ChainPreflightFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainPreflightFailure';
  }
}

type CheckOutcome = { kind: 'passed' } | { kind: 'failed'; reason: string } | { kind: 'unreachable'; reason: string };

/**
 * Boot-time chain preflight. For every non-sandbox chain it requires, before any payment path may run:
 *   1. getGenesisHash equals the genesis hash of the configured network (SOLANA_GENESIS_HASHES), so the RPC really serves that
 *      cluster (a devnet RPC with a mainnet mint, or the reverse, is refused regardless of what the URL looks like);
 *   2. the configured USDC mint account exists, is owned by the classic SPL Token program, is an initialized mint and has 6 decimals.
 * Mint/freeze authority presence is logged for the operator, never a failure (the real USDC mint has both).
 *
 * Fail closed: a definitive failure at boot throws from onModuleInit (the API refuses to start). An RPC that is merely unreachable
 * at boot starts the API degraded: isReady() is false (checkout and transfers refuse to prepare) and the check repeats on a timer
 * until it passes. A definitive failure found by a re-check keeps the process running but permanently not ready.
 */
export class ChainPreflight implements ChainReadiness, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChainPreflight.name);
  private state: PreflightState = 'pending';
  private failure = 'chain preflight has not completed yet';
  private timer: NodeJS.Timeout | undefined;
  private destroyed = false;
  private readonly retryMs: number;
  private readonly callTimeoutMs: number;
  private connection: PreflightConnection | undefined;

  constructor(
    private readonly config: Pick<WalletRuntimeConfig, 'chainMode' | 'solanaNetwork' | 'solanaRpcUrl' | 'usdcMint'>,
    private readonly options: ChainPreflightOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 30_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 10_000;
  }

  getState(): PreflightState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === 'passed' || this.state === 'skipped';
  }

  reason(): string {
    return this.isReady() ? '' : this.failure;
  }

  async onModuleInit(): Promise<void> {
    if (this.config.chainMode === 'sandbox') {
      this.state = 'skipped';
      this.logger.log('Chain preflight skipped: the in-memory sandbox chain has no cluster to check.');
      return;
    }
    const outcome = await this.runCheck();
    if (outcome.kind === 'failed') {
      throw new Error(`Chain preflight failed, refusing to start: ${outcome.reason}`);
    }
    if (outcome.kind === 'unreachable') {
      this.logger.error(`Chain preflight: ${outcome.reason}. Starting DEGRADED: payments are refused until the check passes (retry every ${this.retryMs} ms).`);
      this.scheduleRetry();
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One full check; updates state. Never throws. */
  async runCheck(): Promise<CheckOutcome> {
    let outcome: CheckOutcome;
    try {
      await this.check();
      outcome = { kind: 'passed' };
    } catch (error) {
      // An RPC URL may carry a provider API key in its path or query: never let it reach a log line.
      const message = (error instanceof Error ? error.message : 'unknown error').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
      outcome = error instanceof ChainPreflightFailure ? { kind: 'failed', reason: message } : { kind: 'unreachable', reason: `Solana RPC could not be read (${message})` };
    }
    if (outcome.kind === 'passed') {
      this.state = 'passed';
      this.failure = '';
    } else {
      this.state = outcome.kind === 'failed' ? 'failed' : 'degraded';
      this.failure = outcome.reason;
    }
    return outcome;
  }

  private scheduleRetry(): void {
    if (this.destroyed) return;
    this.timer = setTimeout(() => {
      void this.runCheck().then((outcome) => {
        if (outcome.kind === 'passed') {
          this.logger.log('Chain preflight passed after a degraded start; payments are enabled.');
        } else if (outcome.kind === 'failed') {
          this.logger.error(`Chain preflight FAILED on re-check; payments stay refused until the configuration is fixed and the API restarted: ${outcome.reason}`);
        } else {
          this.scheduleRetry();
        }
      });
    }, this.retryMs);
    this.timer.unref();
  }

  private async check(): Promise<void> {
    const { solanaNetwork: network, usdcMint } = this.config;
    const expectedGenesis = SOLANA_GENESIS_HASHES[network];
    if (!expectedGenesis) throw new ChainPreflightFailure(`no genesis hash is known for network ${String(network)}`);
    if (!usdcMint) throw new ChainPreflightFailure(`no USDC mint is configured for ${network}`);
    let mintKey: PublicKey;
    try {
      mintKey = new PublicKey(usdcMint);
    } catch {
      throw new ChainPreflightFailure('SOLANA_USDC_MINT is not a valid base58 public key');
    }
    const connection = this.getConnection();

    const genesis = await this.withTimeout(connection.getGenesisHash(), 'getGenesisHash');
    if (genesis !== expectedGenesis) {
      throw new ChainPreflightFailure(
        `the RPC reports genesis hash ${genesis}, but ${network} expects ${expectedGenesis}: SOLANA_RPC_URL does not serve ${network}`,
      );
    }

    const info = await this.withTimeout(connection.getAccountInfo(mintKey, 'finalized'), 'getAccountInfo');
    if (!info) throw new ChainPreflightFailure(`the USDC mint ${usdcMint} does not exist on ${network}`);
    if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new ChainPreflightFailure(`the USDC mint ${usdcMint} is owned by ${info.owner.toBase58()}, not the SPL Token program (Token-2022 mints are not supported)`);
    }
    const data = Buffer.from(info.data);
    if (data.length < MINT_SIZE) throw new ChainPreflightFailure(`the account ${usdcMint} is not a token mint (data length ${data.length})`);
    const mint = MintLayout.decode(data.subarray(0, MINT_SIZE));
    if (!mint.isInitialized) throw new ChainPreflightFailure(`the USDC mint ${usdcMint} is not initialized`);
    if (mint.decimals !== USDC_DECIMALS) {
      throw new ChainPreflightFailure(`the USDC mint ${usdcMint} has ${mint.decimals} decimals, expected ${USDC_DECIMALS}`);
    }
    this.logger.log(
      `Chain preflight passed on ${network}: genesis hash matches; mint ${usdcMint} is an initialized SPL Token mint with ${mint.decimals} decimals ` +
        `(mint authority ${mint.mintAuthorityOption ? 'present' : 'absent'}, freeze authority ${mint.freezeAuthorityOption ? 'present' : 'absent'}).`,
    );
  }

  private getConnection(): PreflightConnection {
    this.connection ??= this.options.connection ?? new Connection(this.config.solanaRpcUrl, 'finalized');
    return this.connection;
  }

  private withTimeout<T>(call: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${this.callTimeoutMs} ms`)), this.callTimeoutMs);
      timer.unref();
    });
    return Promise.race([call, timeout]).finally(() => timer && clearTimeout(timer));
  }
}

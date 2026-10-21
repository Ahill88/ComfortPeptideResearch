/**
 * Checkout top-up orchestration: "buy USDC with a card/bank, then pay this order automatically".
 *
 * Pure module (no React, no DOM, no network, no clock of its own). Everything with a side effect is injected:
 * balance reads, opening the provider widget, sleeping, the clock, key-value storage, and the prepare / validate /
 * sign / submit steps of the existing authorization flow.
 *
 * Invariants this module enforces (and tests/wallet/topup-flow.test.ts exercises):
 *  - Nothing is ever signed unless the customer gave explicit consent up front (plan.consentedAt) and that consent is recent.
 *  - Signing happens only after a FRESH balance read says spendable >= the order total. A stale or unreadable balance is
 *    "unknown", never 0 and never "enough".
 *  - The pay step runs at most once per run, and at most once across runs sharing the same storage record.
 *  - If funds arrived but are still short, the run stops and says so. It never re-tops-up or keeps looping silently.
 *  - Timeout, cancel, a closed widget window, or a reload leave the order awaiting payment and sign nothing.
 *  - Only public identifiers are persisted: order id, intent id, amounts, timestamps. Never keys, signatures or secrets.
 */

/* ------------------------------ types ------------------------------ */

export type BalanceRead = { spendableAtomic: bigint; stale: boolean };

/** Result of trying to show the provider widget. `isClosed` is only available when the browser gave us a window handle. */
export type WidgetOpenResult =
  | { status: 'opened'; isClosed?: () => boolean }
  | { status: 'blocked' }
  | { status: 'unavailable' };

/** What the customer sees about the widget. 'sandbox' = no real provider; 'resumed' = reloaded, no window to point at. */
export type WidgetStatus = 'not-opened' | 'opened' | 'closed' | 'blocked' | 'unavailable' | 'sandbox' | 'resumed';

export type PreparedPayment = {
  amountAtomic: bigint; merchant: string; expiresAt: string | null;
  /** True when the platform pays the Solana network fee: the customer needs no SOL and the SOL check below is never made. Absent/false = the customer pays. */
  feeSponsored?: boolean;
  /** Estimated network fee in lamports, if the API gave one. Used only when the customer pays it. */
  feeLamports?: bigint | null;
};

/**
 * The only SOL requirement in the pay step. A fee-sponsored payment needs no SOL, so it never has a SOL problem.
 * When the customer pays the fee, a KNOWN balance below the estimated fee is a reason not to sign; an unknown balance or
 * an unknown fee is not (the API still enforces it). Pure: no I/O.
 */
export function solFeeProblem(prepared: Pick<PreparedPayment, 'feeSponsored' | 'feeLamports'>, solLamports: bigint | null): string | null {
  if (prepared.feeSponsored === true) return null;
  if (solLamports === null || prepared.feeLamports === null || prepared.feeLamports === undefined) return null;
  return solLamports < prepared.feeLamports ? 'Your wallet does not hold enough SOL to pay the network fee, which your own wallet pays for this payment.' : null;
}

export type TopUpDeps<P extends PreparedPayment> = {
  /** Resolves a balance read, or throws when the balance cannot be read at all (treated as unknown). */
  fetchBalance: (signal: AbortSignal) => Promise<BalanceRead>;
  /** Called synchronously from start() (inside the customer's click) so popup blockers allow it. Not used for sandbox plans. */
  openWidget: (widgetUrl: string) => WidgetOpenResult;
  /** Resolves after ms, or as soon as the signal aborts. Never rejects. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  /** Existing authorization flow, split so the machine can refuse to sign. */
  prepare: () => Promise<P>;
  /** Returns reasons NOT to sign (wrong network, wrong amount, transaction does not match, ...). Empty = ok. */
  validate: (prepared: P) => Promise<string[]> | string[];
  sign: (prepared: P) => Promise<string>;
  /**
   * Optional read of the customer's SOL balance in lamports (null = unknown). Called ONLY when the customer pays the network fee;
   * never called for a fee-sponsored payment. A throw is treated as unknown.
   */
  solBalanceLamports?: () => Promise<bigint | null>;
  submit: (prepared: P, signed: string) => Promise<void>;
  /** Optional persistence for reload-resume and the cross-instance double-trigger guard. */
  store?: TopUpStore | null;
};

export type TopUpOptions = {
  pollMs: number;
  timeoutMs: number;
  /** Consent older than this is no longer enough to sign. */
  consentMaxAgeMs: number;
  /** Consecutive identical fresh reads that count as "the deposit has settled". */
  settleReads: number;
};

export const DEFAULT_TOPUP_OPTIONS: TopUpOptions = {
  pollMs: 3000,
  timeoutMs: 20 * 60 * 1000,
  consentMaxAgeMs: 60 * 60 * 1000,
  settleReads: 2,
};

export type TopUpPlan = {
  orderId: string;
  intentId: string;
  /** The order total in USDC base units. */
  requiredAtomic: bigint;
  /** Spendable at the time the quote was made; used to notice that funds have arrived. null = learn it from the first fresh read. */
  baselineSpendableAtomic: bigint | null;
  /** When the customer ticked and confirmed the up-front consent (epoch ms). null/undefined = no consent given. */
  consentedAt: number | null;
  widgetUrl: string | null;
  sandbox: boolean;
  /** Merchant address shown before consent, if the API provided one. When set, a prepared payment to any other address is refused. */
  merchant: string | null;
  /** Set when a previous page load already started the pay step. Such a plan never auto-pays again. */
  payStartedAt?: number | null;
};

export type TopUpProgress = {
  requiredAtomic: bigint;
  /** Last FRESH spendable reading; null = never read fresh. */
  spendableAtomic: bigint | null;
  /** False when the most recent read was stale or failed: the balance is unknown right now. */
  balanceKnown: boolean;
  lastCheckedAt: number | null;
  checks: number;
  widget: WidgetStatus;
  deadlineAt: number;
  /** True when the run could write its resume record to storage. */
  persisted: boolean;
};

export type PayFailureStage = 'prepare' | 'validate' | 'sign' | 'submit';

export type TopUpState =
  | { kind: 'idle' }
  | { kind: 'blocked'; reason: 'consent-required' | 'consent-expired' | 'invalid-plan' }
  | { kind: 'widget-unavailable' }
  | { kind: 'waiting'; progress: TopUpProgress }
  | { kind: 'short'; requiredAtomic: bigint; spendableAtomic: bigint; shortfallAtomic: bigint; progress: TopUpProgress }
  | { kind: 'timed-out'; progress: TopUpProgress }
  | { kind: 'paying'; progress: TopUpProgress }
  /** Authorization was signed and submitted. The order is NOT paid until the order status endpoint says so. */
  | { kind: 'submitted' }
  /** `submitted` may be true for stage 'submit' failures that lost the response: the payment may or may not exist. */
  | { kind: 'pay-failed'; stage: PayFailureStage; error: unknown; reasons: string[]; mayHaveSubmitted: boolean }
  /** A previous page load already began paying; this one will not sign on its own. */
  | { kind: 'manual-required'; reason: 'pay-already-started' }
  | { kind: 'cancelled' };

export type TopUpRun = {
  /** Fresh consent path. Opens the widget synchronously (call it directly from the click handler), then polls. */
  start: () => TopUpState;
  /** Reload path. Does not open a window (there is no click); polls using the stored consent. */
  resume: () => TopUpState;
  /** After 'short' or 'timed-out': keep watching the balance (short is re-baselined to the current balance). */
  keepWaiting: () => void;
  /** Stops watching and clears the resume record. Returns false when it is too late (the pay step already began). */
  cancel: () => boolean;
  /** Stops watching WITHOUT clearing the resume record (panel closed / page leaving). Never signs afterwards. No-op once paying. */
  suspend: () => void;
  /** Check the balance now (e.g. the tab became visible again) instead of waiting out the poll interval. */
  nudge: () => void;
  getState: () => TopUpState;
  /** Resolves with the next state in which the run is at rest (anything but waiting/paying/idle). */
  whenSettled: () => Promise<TopUpState>;
};

/* ------------------------------ storage ------------------------------ */

export type KeyValueStorage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void; removeItem: (key: string) => void };

export type TopUpRecord = {
  v: 1;
  email: string;
  orderId: string;
  intentId: string;
  requiredAtomic: string;
  baselineSpendableAtomic: string | null;
  consentedAt: number;
  payStartedAt: number | null;
  /** Sandbox quotes have no real widget; the sandbox "simulate deposit" control must be offered again after a reload. */
  sandbox: boolean;
};

export type TopUpStore = {
  /** Returns false when the browser refused the write (private mode, quota). */
  save: (record: TopUpRecord) => boolean;
  load: () => TopUpRecord | null;
  clear: () => void;
};

export const TOPUP_STORAGE_KEY = 'hf.checkout.topup.v1';

const isDecimal = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}$/.test(value);
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Defensive parse: anything unexpected is treated as "no record". Only the known public fields survive. */
export function parseTopUpRecord(raw: string | null): TopUpRecord | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || !isNonEmpty(r.email) || !isNonEmpty(r.orderId) || !isNonEmpty(r.intentId) || !isDecimal(r.requiredAtomic)) return null;
  if (r.baselineSpendableAtomic !== null && !isDecimal(r.baselineSpendableAtomic)) return null;
  if (typeof r.consentedAt !== 'number' || !Number.isFinite(r.consentedAt)) return null;
  if (r.payStartedAt !== null && (typeof r.payStartedAt !== 'number' || !Number.isFinite(r.payStartedAt))) return null;
  return {
    v: 1, email: r.email, orderId: r.orderId, intentId: r.intentId, requiredAtomic: r.requiredAtomic,
    baselineSpendableAtomic: r.baselineSpendableAtomic as string | null, consentedAt: r.consentedAt, payStartedAt: r.payStartedAt as number | null, sandbox: r.sandbox === true,
  };
}

export function createTopUpStore(storage: KeyValueStorage, key: string = TOPUP_STORAGE_KEY): TopUpStore {
  return {
    save(record) { try { storage.setItem(key, JSON.stringify(record)); return true; } catch { return false; } },
    load() { try { return parseTopUpRecord(storage.getItem(key)); } catch { return null; } },
    clear() { try { storage.removeItem(key); } catch { /* storage unavailable: nothing to clear */ } },
  };
}

export type ResumeLookup =
  | { kind: 'none' }
  | { kind: 'expired'; record: TopUpRecord }
  | { kind: 'resume'; record: TopUpRecord; plan: TopUpPlan };

/** Finds a top-up this browser tab left behind for this account. A record for another account is ignored. */
export function findResumableTopUp(store: TopUpStore, email: string, nowMs: number, consentMaxAgeMs: number = DEFAULT_TOPUP_OPTIONS.consentMaxAgeMs): ResumeLookup {
  const record = store.load();
  if (!record || record.email !== email.trim().toLowerCase()) return { kind: 'none' };
  if (nowMs - record.consentedAt > consentMaxAgeMs || record.consentedAt > nowMs + 60_000) return { kind: 'expired', record };
  return {
    kind: 'resume',
    record,
    plan: {
      orderId: record.orderId,
      intentId: record.intentId,
      requiredAtomic: BigInt(record.requiredAtomic),
      baselineSpendableAtomic: record.baselineSpendableAtomic === null ? null : BigInt(record.baselineSpendableAtomic),
      consentedAt: record.consentedAt,
      widgetUrl: null,
      sandbox: record.sandbox,
      merchant: null,
      payStartedAt: record.payStartedAt,
    },
  };
}

/* ------------------------------ helpers ------------------------------ */

/** Only https widget URLs are ever opened. A sandbox "widget" is a local path and is never opened as a window. */
export function safeWidgetUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : null; } catch { return null; }
}

const REST_KINDS = new Set<TopUpState['kind']>(['blocked', 'widget-unavailable', 'short', 'timed-out', 'submitted', 'pay-failed', 'manual-required', 'cancelled']);

/* ------------------------------ the run ------------------------------ */

export function createTopUpRun<P extends PreparedPayment>(
  plan: TopUpPlan,
  deps: TopUpDeps<P>,
  email: string,
  options: Partial<TopUpOptions> = {},
  onState?: (state: TopUpState) => void,
): TopUpRun {
  const opt: TopUpOptions = { ...DEFAULT_TOPUP_OPTIONS, ...options };
  const store = deps.store ?? null;
  const account = email.trim().toLowerCase();

  let state: TopUpState = { kind: 'idle' };
  let stopped = false;          // cancelled or finished: no further polling
  let payInvoked = false;       // the pay step has begun (at most once per run)
  let loopRunning = false;
  let baseline: bigint | null = plan.baselineSpendableAtomic;
  let widget: WidgetStatus = 'not-opened';
  let widgetHandle: { isClosed?: () => boolean } | null = null;
  let persisted = false;
  let deadlineAt = 0;
  let checks = 0;
  let lastCheckedAt: number | null = null;
  let spendable: bigint | null = null;
  let balanceKnown = false;
  let settle: { value: bigint; count: number } | null = null;
  const controller = new AbortController();
  let sleepController: AbortController | null = null;
  const settledWaiters: Array<(s: TopUpState) => void> = [];

  const progress = (): TopUpProgress => ({ requiredAtomic: plan.requiredAtomic, spendableAtomic: spendable, balanceKnown, lastCheckedAt, checks, widget, deadlineAt, persisted });

  function emit(next: TopUpState) {
    state = next;
    onState?.(next);
    if (REST_KINDS.has(next.kind)) for (const resolve of settledWaiters.splice(0)) resolve(next);
  }

  function consentProblem(): 'consent-required' | 'consent-expired' | null {
    if (plan.consentedAt === null || plan.consentedAt === undefined || !Number.isFinite(plan.consentedAt)) return 'consent-required';
    const age = deps.now() - plan.consentedAt;
    if (age > opt.consentMaxAgeMs || age < -60_000) return 'consent-expired';
    return null;
  }

  function record(payStartedAt: number | null): TopUpRecord {
    return {
      v: 1, email: account, orderId: plan.orderId, intentId: plan.intentId, requiredAtomic: plan.requiredAtomic.toString(),
      baselineSpendableAtomic: baseline === null ? null : baseline.toString(), consentedAt: plan.consentedAt as number, payStartedAt, sandbox: plan.sandbox,
    };
  }

  function validPlan(): boolean {
    return plan.orderId.length > 0 && plan.intentId.length > 0 && plan.requiredAtomic > 0n;
  }

  function begin(): TopUpState {
    if (state.kind !== 'idle') return state;
    if (!validPlan()) { stopped = true; emit({ kind: 'blocked', reason: 'invalid-plan' }); return state; }
    const problem = consentProblem();
    if (problem) { stopped = true; emit({ kind: 'blocked', reason: problem }); return state; }
    if (plan.payStartedAt) { stopped = true; emit({ kind: 'manual-required', reason: 'pay-already-started' }); return state; }
    return state;
  }

  async function runLoop() {
    if (loopRunning || stopped) return;
    loopRunning = true;
    try {
      while (!stopped) {
        if (deps.now() >= deadlineAt) { stopped = true; emit({ kind: 'timed-out', progress: progress() }); return; }
        if (widgetHandle?.isClosed && widget === 'opened') {
          try { if (widgetHandle.isClosed()) widget = 'closed'; } catch { /* cross-origin access refused: leave as opened */ }
        }
        let read: BalanceRead | null = null;
        try { read = await deps.fetchBalance(controller.signal); } catch { read = null; }
        if (stopped) return;
        checks += 1;
        lastCheckedAt = deps.now();
        if (read && !read.stale && read.spendableAtomic >= 0n) {
          balanceKnown = true;
          spendable = read.spendableAtomic;
          if (read.spendableAtomic >= plan.requiredAtomic) { await pay(); return; }
          if (baseline === null) baseline = read.spendableAtomic;
          settle = settle && settle.value === read.spendableAtomic ? { value: settle.value, count: settle.count + 1 } : { value: read.spendableAtomic, count: 1 };
          if (read.spendableAtomic > baseline && settle.count >= opt.settleReads) {
            emit({ kind: 'short', requiredAtomic: plan.requiredAtomic, spendableAtomic: read.spendableAtomic, shortfallAtomic: plan.requiredAtomic - read.spendableAtomic, progress: progress() });
            return;
          }
        } else {
          // Stale, failed or unavailable: UNKNOWN. Do not touch spendable/baseline, do not count towards settling, never treat as 0.
          balanceKnown = false;
          settle = null;
        }
        emit({ kind: 'waiting', progress: progress() });
        sleepController = new AbortController();
        const onAbort = () => sleepController?.abort();
        controller.signal.addEventListener('abort', onAbort, { once: true });
        await deps.sleep(opt.pollMs, sleepController.signal);
        controller.signal.removeEventListener('abort', onAbort);
        sleepController = null;
      }
    } finally {
      loopRunning = false;
    }
  }

  async function pay() {
    // Single-fire guard, in-process.
    if (payInvoked || stopped) return;
    // Consent is re-checked at the moment of signing, not just at the start.
    const problem = consentProblem();
    if (problem) { stopped = true; emit({ kind: 'blocked', reason: problem }); return; }
    // Single-fire guard across runs that share the record (two mounted panels, a double effect, a reload mid-sign).
    if (persisted && store) {
      const current = store.load();
      if (!current || current.orderId !== plan.orderId || current.payStartedAt !== null) {
        stopped = true;
        emit(current ? { kind: 'manual-required', reason: 'pay-already-started' } : { kind: 'cancelled' });
        return;
      }
      store.save({ ...current, payStartedAt: deps.now() });
    }
    payInvoked = true;
    emit({ kind: 'paying', progress: progress() });

    let prepared: P;
    try { prepared = await deps.prepare(); } catch (error) { emit({ kind: 'pay-failed', stage: 'prepare', error, reasons: [], mayHaveSubmitted: false }); return; }

    const reasons: string[] = [];
    if (prepared.amountAtomic !== plan.requiredAtomic) reasons.push('The payment amount does not match your order total.');
    if (plan.merchant !== null && prepared.merchant !== plan.merchant) reasons.push('The payment recipient is not the merchant address shown before you agreed.');
    if (prepared.expiresAt && Date.parse(prepared.expiresAt) <= deps.now()) reasons.push('This payment request has already expired.');
    try { reasons.push(...(await deps.validate(prepared))); } catch (error) { emit({ kind: 'pay-failed', stage: 'validate', error, reasons: ['The payment could not be verified.'], mayHaveSubmitted: false }); return; }
    if (prepared.feeSponsored !== true && deps.solBalanceLamports) {
      let sol: bigint | null = null;
      try { sol = await deps.solBalanceLamports(); } catch { sol = null; }
      const solProblem = solFeeProblem(prepared, sol);
      if (solProblem) reasons.push(solProblem);
    }
    if (reasons.length) { emit({ kind: 'pay-failed', stage: 'validate', error: null, reasons, mayHaveSubmitted: false }); return; }

    let signed: string;
    try { signed = await deps.sign(prepared); } catch (error) { emit({ kind: 'pay-failed', stage: 'sign', error, reasons: [], mayHaveSubmitted: false }); return; }
    try { await deps.submit(prepared, signed); } catch (error) { emit({ kind: 'pay-failed', stage: 'submit', error, reasons: [], mayHaveSubmitted: true }); return; }
    stopped = true;
    emit({ kind: 'submitted' });
  }

  function launch() {
    deadlineAt = deps.now() + opt.timeoutMs;
    void runLoop();
  }

  return {
    start() {
      if (begin().kind !== 'idle') return state;
      // 1) Remember the consent so a reload/closed tab can resume. 2) Open the widget inside the click. 3) Poll.
      persisted = store ? store.save(record(null)) : false;
      if (plan.sandbox) widget = 'sandbox';
      else {
        const opened = plan.widgetUrl ? deps.openWidget(plan.widgetUrl) : ({ status: 'unavailable' } as const);
        if (opened.status === 'unavailable') { stopped = true; store?.clear(); emit({ kind: 'widget-unavailable' }); return state; }
        widget = opened.status === 'opened' ? 'opened' : 'blocked';
        widgetHandle = opened.status === 'opened' ? opened : null;
      }
      deadlineAt = deps.now() + opt.timeoutMs;
      emit({ kind: 'waiting', progress: progress() });
      launch();
      return state;
    },
    resume() {
      if (begin().kind !== 'idle') return state;
      persisted = store ? store.save(record(null)) : false;
      widget = plan.sandbox ? 'sandbox' : 'resumed';
      deadlineAt = deps.now() + opt.timeoutMs;
      emit({ kind: 'waiting', progress: progress() });
      launch();
      return state;
    },
    keepWaiting() {
      if (payInvoked || (state.kind !== 'short' && state.kind !== 'timed-out')) return;
      if (state.kind === 'short') { baseline = state.spendableAtomic; settle = null; }
      stopped = false;
      deadlineAt = deps.now() + opt.timeoutMs;
      emit({ kind: 'waiting', progress: progress() });
      void runLoop();
    },
    cancel() {
      if (payInvoked) return false;
      stopped = true;
      controller.abort();
      store?.clear();
      emit({ kind: 'cancelled' });
      return true;
    },
    suspend() {
      if (payInvoked) return;
      stopped = true;
      controller.abort();
    },
    nudge() { sleepController?.abort(); },
    getState: () => state,
    whenSettled() {
      return REST_KINDS.has(state.kind) ? Promise.resolve(state) : new Promise<TopUpState>((resolve) => settledWaiters.push(resolve));
    },
  };
}

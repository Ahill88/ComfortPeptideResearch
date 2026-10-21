import type { CartLine, CartQuote } from './model';

export type QuoteState =
  | { key: string; kind: 'idle' | 'loading' }
  | { key: string; kind: 'ready'; snapshot: CartQuote }
  | { key: string; kind: 'error'; message: string };

/** Aborting fetch alone is insufficient: an already resolved response (or a transport ignoring abort) can still arrive. */
export function createQuoteRequest(load: (items: readonly CartLine[], signal: AbortSignal) => Promise<CartQuote>, publish: (state: QuoteState) => void, delayMs = 300) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const cancel = () => { generation += 1; clearTimeout(timer); controller?.abort(); };
  return {
    cancel,
    schedule(key: string, items: readonly CartLine[]) {
      cancel();
      const mine = generation;
      const abort = new AbortController();
      controller = abort;
      publish({ key, kind: 'loading' });
      timer = setTimeout(async () => {
        try {
          const snapshot = await load(items, abort.signal);
          if (mine === generation && !abort.signal.aborted) publish({ key, kind: 'ready', snapshot });
        } catch (error) {
          if (mine === generation && !abort.signal.aborted) publish({ key, kind: 'error', message: error instanceof Error ? error.message : 'Quote unavailable. Please try again.' });
        }
      }, delayMs);
    },
  };
}

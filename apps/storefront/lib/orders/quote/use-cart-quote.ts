'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchCartQuote } from './client';
import { canCheckout, cartKey, type CartLine } from './model';
import { createQuoteRequest, type QuoteState } from './request';

export function useCartQuote(items: readonly CartLine[], enabled: boolean) {
  const key = cartKey(items);
  const [revision, setRevision] = useState(0);
  const requestKey = `${revision}:${key}`;
  const [result, setResult] = useState<QuoteState>({ key: '', kind: 'idle' });
  const active = enabled && items.length > 0;
  useEffect(() => {
    if (!active) return;
    const request = createQuoteRequest((lines, signal) => fetchCartQuote(lines, { signal }), setResult);
    request.schedule(requestKey, JSON.parse(key) as CartLine[]);
    return request.cancel;
  }, [key, requestKey, active]);
  // Invalidate during render, before the effect runs: an old quote must never enable a new cart's checkout button.
  const state: QuoteState = !active ? { key: requestKey, kind: 'idle' } : result.key === requestKey ? result : { key: requestKey, kind: 'loading' };
  const snapshot = state.kind === 'ready' ? state.snapshot : null;
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return { state, snapshot, refresh, canCheckout: canCheckout(snapshot) };
}

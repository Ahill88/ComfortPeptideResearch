'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CUSTOMER_ORDERS_REFRESH_MS, customerOrdersErrorStatus } from '../../lib/orders/customer-orders-api';

type OrderResource<T> = {
  data: T | null;
  phase: 'loading' | 'ready' | 'error' | 'signed-out' | 'not-found';
  refreshing: boolean;
  refreshFailed: boolean;
};

/** One in-flight read, aborted on navigation/account change. Background failures preserve the last successful read. */
export function useCustomerOrders<T>(load: (signal: AbortSignal) => Promise<T>, needsRefresh: (data: T) => boolean) {
  const [state, setState] = useState<OrderResource<T>>({ data: null, phase: 'loading', refreshing: false, refreshFailed: false });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let data: T | null = null;
    let lastChecked = 0;
    let controller: AbortController | null = null;
    let timer: number | undefined;
    setState({ data: null, phase: 'loading', refreshing: false, refreshFailed: false });

    const read = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      window.clearTimeout(timer);
      controller = new AbortController();
      setState((current) => ({ ...current, phase: data === null ? 'loading' : 'ready', refreshing: data !== null, refreshFailed: false }));
      try {
        const result = await load(controller.signal);
        if (!active) return;
        data = result;
        setState({ data, phase: 'ready', refreshing: false, refreshFailed: false });
      } catch (error) {
        if (!active) return;
        const status = customerOrdersErrorStatus(error);
        if (status === 401 || status === 404) {
          data = null;
          setState({ data: null, phase: status === 401 ? 'signed-out' : 'not-found', refreshing: false, refreshFailed: false });
        } else {
          setState({ data, phase: data === null ? 'error' : 'ready', refreshing: false, refreshFailed: data !== null });
        }
      } finally {
        inFlight = false;
        lastChecked = Date.now();
        if (active && data !== null && needsRefresh(data)) {
          timer = window.setTimeout(() => {
            if (document.visibilityState === 'visible') void read();
          }, CUSTOMER_ORDERS_REFRESH_MS);
        }
      }
    };
    const refreshIfDue = () => {
      if (document.visibilityState === 'visible' && data !== null && needsRefresh(data) && Date.now() - lastChecked >= CUSTOMER_ORDERS_REFRESH_MS) void read();
    };
    refreshRef.current = () => { void read(); };
    void read();
    document.addEventListener('visibilitychange', refreshIfDue);
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshIfDue);
      refreshRef.current = () => {};
    };
  }, [load, needsRefresh]);

  return { ...state, refresh };
}

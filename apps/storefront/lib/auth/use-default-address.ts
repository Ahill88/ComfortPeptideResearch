'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../components/auth-provider';
import { authApi, authErrorMessage } from './api';
import { defaultAddress, formatAddress } from './addresses';
import type { Address } from './types';

export { formatAddress, formatShippingAddress } from './addresses';

export function useAddresses() {
  const { session, isReady } = useAuth();
  const customerId = session?.id ?? null;
  const [state, setState] = useState<{ owner: string | null; addresses: Address[]; loading: boolean; error: string | null }>({ owner: null, addresses: [], loading: false, error: null });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!customerId) { setState({ owner: null, addresses: [], loading: false, error: null }); return; }
    setState((old) => ({ owner: customerId, addresses: old.owner === customerId ? old.addresses : [], loading: true, error: null }));
    try {
      const addresses = await authApi.addresses();
      if (current === generation.current) setState({ owner: customerId, addresses, loading: false, error: null });
    } catch (cause) {
      if (current === generation.current) setState({ owner: customerId, addresses: [], loading: false, error: authErrorMessage(cause) });
    }
  }, [customerId]);
  useEffect(() => { void refresh(); return () => { ++generation.current; }; }, [refresh]);
  const sameOwner = state.owner === customerId;
  return { addresses: sameOwner ? state.addresses : [], loading: !isReady || (!!customerId && (!sameOwner || state.loading)), error: sameOwner ? state.error : null, refresh };
}

/** Checkout may prefill once when ready; do not overwrite a shipping address the customer has already edited. */
export function useDefaultAddress() {
  const { addresses, ...rest } = useAddresses();
  const address = defaultAddress(addresses);
  return { ...rest, address, shippingAddress: address ? formatAddress(address) : '' };
}

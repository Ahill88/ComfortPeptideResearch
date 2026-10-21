'use client';

import { useEffect, useRef } from 'react';

/** GET form, so a search is a bookmarkable URL (the query is an order id or email, never a secret). Press "/" to focus. */
export function QueueSearch({ tab, q, defaultTab }: { tab: string; q: string; defaultTab: string }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form className="toolbar" action="/orders" method="get" role="search">
      {tab !== defaultTab && <input type="hidden" name="tab" value={tab} />}
      <div className="search">
        <div className="field" style={{ flex: 1, margin: 0 }}>
          <label htmlFor="q">Search by order ID or customer email</label>
          <input ref={input} id="q" name="q" type="search" defaultValue={q} maxLength={100} autoComplete="off" spellCheck={false} aria-describedby="q-hint" />
          <span className="hint" id="q-hint">Press / to jump here.</span>
        </div>
        <button className="btn-primary" type="submit" style={{ alignSelf: 'flex-start', marginTop: 22 }}>Search</button>
        {q && <a className="btn" style={{ alignSelf: 'flex-start', marginTop: 22 }} href={tab === defaultTab ? '/orders' : `/orders?tab=${tab}`}>Clear</a>}
      </div>
    </form>
  );
}

'use client';

export function PrintButton() {
  return <button type="button" className="btn-primary btn-lg" onClick={() => window.print()}>Print packing slip</button>;
}

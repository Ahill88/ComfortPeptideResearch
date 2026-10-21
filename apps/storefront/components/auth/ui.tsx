'use client';

import type { InputHTMLAttributes, ReactNode } from 'react';

export const inputClass = 'min-h-11 w-full rounded-xl border border-silver bg-white px-4 py-3 text-sm text-midnight outline-none focus:border-slate-500 focus:ring-2 focus:ring-ice disabled:opacity-60';
export const buttonClass = 'inline-flex min-h-11 items-center justify-center rounded-xl border border-silver px-5 py-3 text-sm font-medium transition hover:bg-porcelain disabled:cursor-not-allowed disabled:opacity-50';
export const primaryClass = `${buttonClass} border-midnight bg-midnight text-white hover:bg-slate-700`;
export const cardClass = 'min-w-0 rounded-2xl border border-silver bg-white p-6 sm:p-8';

export function Status({ error, message }: { error?: string | null; message?: string | null }) {
  return <div aria-live="polite" aria-atomic="true" className="text-sm leading-6">
    {error ? <p role="alert" className="my-4 rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error}</p> : message ? <p role="status" className="my-4 rounded-xl border border-silver bg-porcelain p-4">{message}</p> : null}
  </div>;
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = props.id ?? props.name;
  return <div><label htmlFor={id} className="mb-2 block text-sm font-medium">{label}</label><input {...props} id={id} className={inputClass} aria-describedby={hint ? `${id}-hint` : props['aria-describedby']} />{hint && <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-slate-600">{hint}</p>}</div>;
}

export function AccessShell({ title, children }: { title: string; children: ReactNode }) {
  return <main className="min-h-[65vh] bg-porcelain px-5 py-12 text-midnight sm:px-8 lg:py-20"><section className={`${cardClass} mx-auto max-w-xl`}><p className="text-xs font-medium tracking-widest text-slate-600">CUSTOMER ACCOUNT</p><h1 className="mb-7 mt-4 text-4xl tracking-tight">{title}</h1>{children}</section></main>;
}

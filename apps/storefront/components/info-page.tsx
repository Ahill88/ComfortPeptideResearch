import type { ReactNode } from 'react';

export function InfoPage({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <main className="mx-auto min-h-[65vh] max-w-5xl px-5 py-14 font-sans text-[#0B1220] sm:px-8 lg:py-24"><p className="text-[11px] font-semibold uppercase tracking-[.18em] text-slate-500">{eyebrow}</p><h1 className="mt-5 max-w-4xl border-b border-slate-200 pb-9 text-4xl font-medium leading-[1.08] tracking-[-.045em] sm:text-6xl lg:text-7xl">{title}</h1><div className="mt-10 max-w-3xl space-y-8 text-base leading-8 text-slate-600 [&_h2]:mb-3 [&_h2]:font-sans [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:tracking-tight [&_h2]:text-[#0B1220] [&_h3]:font-sans [&_h3]:font-semibold [&_h3]:text-[#0B1220] [&_a]:underline-offset-4">{children}</div></main>;
}

import type { ReactNode } from 'react';

export function SectionHeading({ eyebrow, title, children, id }: { eyebrow: string; title: string; children?: ReactNode; id?: string }) {
  return <div className="max-w-2xl"><p className="eyebrow mb-5 opacity-70">{eyebrow}</p><h2 id={id} className="heading-section">{title}</h2>{children && <div className="mt-6 max-w-lg text-sm leading-7 opacity-75">{children}</div>}</div>;
}

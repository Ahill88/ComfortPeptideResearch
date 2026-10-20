import Link from 'next/link';

const groups = [
  { title: 'Explore', links: [['Catalog', '/catalog'], ['Research', '/research'], ['Quality', '/quality'], ['About', '/about']] },
  { title: 'Information', links: [['Shipping', '/shipping'], ['Returns', '/returns'], ['Terms', '/terms'], ['Privacy', '/privacy']] },
  { title: 'Connect', links: [['Contact', '/contact'], ['Account', '/account'], ['Access', '/access']] },
];

export function Footer() {
  return <footer className="bg-[#0B1220] px-5 pb-7 pt-16 font-sans text-white lg:px-8"><div className="mx-auto grid max-w-[1440px] gap-12 border-b border-white/10 pb-14 sm:grid-cols-3 lg:grid-cols-[2fr_repeat(3,1fr)]"><div className="sm:col-span-3 lg:col-span-1"><Link href="/" className="text-2xl font-semibold tracking-tight">Helix &amp; Field</Link><p className="mt-5 max-w-xs text-sm leading-7 text-slate-400">Research materials. Clear information.<br />A considered approach to laboratory supply.</p><span className="mt-6 inline-flex rounded-full border border-sky-100/20 bg-sky-100/5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[.14em] text-sky-100">Research use only</span></div>{groups.map(group => <nav key={group.title} aria-label={`Footer ${group.title}`}><h2 className="mb-5 text-[11px] font-semibold uppercase tracking-[.15em] text-slate-400">{group.title}</h2><ul className="space-y-3">{group.links.map(([label, href]) => <li key={href}><Link href={href} className="text-sm text-slate-200 transition hover:text-sky-200 focus-visible:outline focus-visible:outline-offset-4">{label}</Link></li>)}</ul></nav>)}</div><div className="mx-auto flex max-w-[1440px] flex-col gap-3 pt-7 text-[11px] leading-5 text-slate-400 sm:flex-row sm:justify-between"><p>© {new Date().getFullYear()} Helix &amp; Field</p><p>For laboratory research only. Not for human or veterinary use.</p></div></footer>;
}

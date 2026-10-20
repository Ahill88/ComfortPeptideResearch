import Link from 'next/link';

export default function About() {
  return (
    <main className="mx-auto max-w-[1280px] px-5 py-16 font-sans text-midnight sm:px-8 lg:py-24">
      <p className="text-[10px] font-medium uppercase tracking-[.17em] text-slate-600">About Helix &amp; Field</p>
      <h1 className="mt-5 max-w-3xl text-4xl leading-tight tracking-[-.045em] sm:text-6xl">A considered approach to research purchasing.</h1>
      <section className="mt-10 max-w-3xl space-y-6 rounded-2xl border border-silver bg-white p-7 text-base leading-8 text-slate-600 sm:p-10">
        <p>Helix &amp; Field brings catalog browsing, purchaser eligibility information, and order records into one research-focused storefront.</p>
        <p>Materials listed here are intended for qualified research use only, not for human or animal use. Review each listing and the available documentation when assessing suitability for your work.</p>
        <p>This storefront is a local preview. Account details and sample order records demonstrate the purchasing experience.</p>
        <Link className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-midnight bg-midnight px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700" href="/catalog">Explore the catalog</Link>
      </section>
    </main>
  );
}

export default function Contact() {
  return (
    <main className="mx-auto max-w-[1280px] px-5 py-16 font-sans text-midnight sm:px-8 lg:py-24">
      <p className="text-[10px] font-medium uppercase tracking-[.17em] text-slate-600">Contact</p>
      <h1 className="mt-5 max-w-3xl text-4xl leading-tight tracking-[-.045em] sm:text-6xl">Start a conversation.</h1>
      <section className="mt-10 max-w-3xl rounded-2xl border border-silver bg-white p-7 sm:p-10">
        <h2 className="text-2xl tracking-tight">Purchasing &amp; documentation</h2>
        <p className="mt-5 text-base leading-8 text-slate-600">For questions about a listing, documentation, or an order, include the product name or order reference in your message.</p>
        <a className="mt-8 inline-flex min-h-11 max-w-full items-center justify-center break-all rounded-2xl border border-midnight bg-midnight px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-700" href="mailto:research@helixandfield.example">research@helixandfield.example</a>
        <p className="mt-6 border-t border-silver pt-6 text-sm leading-6 text-slate-500">This is a placeholder email address for the local preview, not a monitored support inbox.</p>
      </section>
    </main>
  );
}

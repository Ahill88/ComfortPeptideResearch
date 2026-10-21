export const dynamic = 'force-dynamic';

export default function Unavailable() {
  return (
    <main className="access-page">
      <section className="access-panel" aria-labelledby="unavailable-title">
        <p className="eyebrow">Helix &amp; Field / Operations</p>
        <h1 id="unavailable-title">Admin API unavailable</h1>
        <p className="msg msg-error" role="alert">The admin API could not be reached, or returned an unexpected response. Nothing has been changed and no data is shown.</p>
        <p><a className="btn-primary btn" href="/">Try again</a></p>
      </section>
    </main>
  );
}

export function Forbidden({ what }: { what: string }) {
  return (
    <div className="panel panel-error" role="alert">
      <p className="code">403</p>
      <h1>Forbidden</h1>
      <p>{what} is available to owners only. Your account has the STAFF role.</p>
      <p><a className="btn" href="/">Back to overview</a></p>
    </div>
  );
}

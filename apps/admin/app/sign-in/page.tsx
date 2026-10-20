import SignInForm from './sign-in-form';

export default function SignIn() {
  const developmentSessionEnabled =
    process.env.NODE_ENV === 'development' &&
    process.env.ADMIN_DEV_SESSION === 'enabled';

  return (
    <main className="access-page">
      <section className="access-panel" aria-labelledby="access-title">
        <p className="eyebrow">Helix &amp; Field / Operations</p>
        <h1 id="access-title">Access denied</h1>
        {developmentSessionEnabled ? (
          <>
            <p>This local development workspace requires an explicit development admin session.</p>
            <SignInForm />
          </>
        ) : (
          <p>Operational dashboard access is not configured for this environment.</p>
        )}
        <p className="access-note">
          Local development only: set <code>ADMIN_DEV_SESSION=enabled</code> in your local environment, then restart the app.
        </p>
        <p className="access-note">
          Production requires identity-provider authentication, server-verified operational RBAC, and MFA before this dashboard can be enabled.
        </p>
      </section>
    </main>
  );
}

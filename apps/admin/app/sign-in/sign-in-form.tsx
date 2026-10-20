'use client';

import { useState } from 'react';

export default function SignInForm() {
  const [error, setError] = useState('');

  async function startDevelopmentSession() {
    setError('');
    const response = await fetch('/api/dev-session', { method: 'POST' });

    if (!response.ok) {
      setError('Development access could not be started. Confirm the local environment configuration.');
      return;
    }

    window.location.assign('/');
  }

  return (
    <>
      <button className="sign-in-button" onClick={startDevelopmentSession}>Start local admin session</button>
      {error && <p className="access-error" role="alert">{error}</p>}
    </>
  );
}

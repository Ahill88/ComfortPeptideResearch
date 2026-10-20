import { NextResponse } from 'next/server';

export async function POST() {
  const developmentSessionEnabled =
    process.env.NODE_ENV === 'development' &&
    process.env.ADMIN_DEV_SESSION === 'enabled';

  if (!developmentSessionEnabled) {
    return NextResponse.json({ error: 'Development admin access is unavailable.' }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set('admin_dev_session', 'active', {
    httpOnly: true,
    path: '/',
    sameSite: 'strict',
  });
  return response;
}

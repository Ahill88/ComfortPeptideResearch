// The only place the session cookie's name and attributes are defined.
// `__Host-` (production) forces Secure + Path=/ + no Domain, so a sibling subdomain cannot overwrite it.
const production = process.env.NODE_ENV === 'production';

export const SESSION_COOKIE = production ? '__Host-hf_admin_session' : 'hf_admin_session';

export const baseCookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: production,
  path: '/',
};

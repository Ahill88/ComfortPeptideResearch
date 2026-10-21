// Only documented, fixed operational 503 messages may cross the server boundary. Other 5xx bodies stay private.
const SANCTIONS_ERRORS = new Set([
  'A refresh is already running.', 'The refresh could not start.', 'The sanctions list could not be refreshed.',
  'The list download exceeded the size limit.', 'The list source must use https.',
  'The list source redirected too many times.', 'The list source returned no body.',
  'The list download was cut off or is not an SDN XML document.',
  'The list did not contain any SDN entries (unrecognised format).', 'The list held more addresses than allowed.',
  'The list download timed out.', 'The list source could not be reached.',
  'The list could not be stored; the previous data was kept.',
  'The downloaded list holds no digital currency addresses; the previous data was kept.',
]);

export function operational503(path: string, message: unknown): string | null {
  if (typeof message !== 'string') return null;
  if (/^\/admin\/orders\/[^/]+\/refund\/submit$/.test(path) && message === 'Refund signing is not available.') return message;
  if (path !== '/admin/compliance/sanctions/refresh') return null;
  return SANCTIONS_ERRORS.has(message)
    || /^The list source answered HTTP \d{3}\.$/.test(message)
    || /^The downloaded list shrank implausibly \(\d+ addresses, previously \d+\); the previous data was kept\.$/.test(message)
    ? message : null;
}

/**
 * Redaction for anything that is logged or stored as lastError. Removes: configured credentials, Bearer values, provider-style
 * keys (re_...), `token=`-style query values, email addresses, URLs' query strings and long opaque strings (24+ chars with a digit or mixed case: token-shaped; plain snake_case names such as provider error codes are kept).
 * Control characters are flattened and the result is capped, so a hostile provider response cannot forge log lines.
 */
export const MAX_REDACTED_LENGTH = 300;

export function redactText(input: unknown, knownValues: readonly (string | null | undefined)[] = []): string {
  let text = typeof input === 'string' ? input : input instanceof Error ? `${input.name}: ${input.message}` : String(input ?? '');
  for (const value of knownValues) {
    if (typeof value === 'string' && value.length >= 6) text = text.split(value).join('[redacted]');
  }
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bre_[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/([?&;\s"'(](?:token|key|api[_-]?key|code|sig|signature|auth|password)=)[^&\s"')]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, '$1?[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/[A-Za-z0-9_-]{24,}/g, (run) => (/\d/.test(run) || (/[A-Z]/.test(run) && /[a-z]/.test(run)) ? '[redacted]' : run))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim();
  return text.length > MAX_REDACTED_LENGTH ? `${text.slice(0, MAX_REDACTED_LENGTH)}...` : text;
}

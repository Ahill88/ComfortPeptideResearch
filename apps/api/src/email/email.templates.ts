import { EmailValidationError } from './email.errors';
import { isKnownTemplate, validateTemplateData } from './email.validation';
import type { EmailTemplate, RenderedEmail } from './email.types';

/**
 * Pure renderers: (validated data) -> { subject, text, html }. No I/O, no clock, no environment. Plain and accessible: semantic
 * HTML, no images, no tracking pixels, no scripts. Every interpolated value is HTML-escaped; links appear both as an anchor and
 * as visible text. Copy is factual and uses the research-use-only storefront voice; it makes no product claims.
 */
const BRAND = 'Helix & Field';
const NOTICE = `${BRAND} is a research-use-only storefront. Products are sold for laboratory research only. Not for human or veterinary use.`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[char] as string);
}

/** Integer cents -> "$1,234.56 USD" (USD shows its symbol). Pure integer arithmetic, no floating point. */
export function formatMoney(cents: number, currency: string): string {
  if (!Number.isInteger(cents) || cents < 0) throw new EmailValidationError('totalCents must be an integer number of cents');
  const whole = Math.trunc(cents / 100).toLocaleString('en-US');
  const fraction = String(cents % 100).padStart(2, '0');
  return currency === 'USD' ? `$${whole}.${fraction} USD` : `${whole}.${fraction} ${currency}`;
}

interface Layout {
  subject: string;
  heading: string;
  paragraphs: string[];
  details?: [string, string][];
  links?: { label: string; url: string }[];
  closing?: string[];
}

function toText(layout: Layout, greeting: string | null): string {
  const lines: string[] = [];
  if (greeting) lines.push(greeting, '');
  for (const paragraph of layout.paragraphs) lines.push(paragraph, '');
  for (const [label, value] of layout.details ?? []) lines.push(`${label}: ${value}`);
  if (layout.details?.length) lines.push('');
  for (const link of layout.links ?? []) lines.push(`${link.label}:`, link.url, '');
  for (const paragraph of layout.closing ?? []) lines.push(paragraph, '');
  lines.push('--', NOTICE);
  return `${lines.join('\n')}\n`;
}

function toHtml(layout: Layout, greeting: string | null): string {
  const p = (text: string) => `<p style="margin:0 0 16px">${escapeHtml(text)}</p>`;
  const body = [
    greeting ? p(greeting) : '',
    ...layout.paragraphs.map(p),
    layout.details?.length ? `<dl style="margin:0 0 16px">${layout.details.map(([k, v]) => `<dt style="font-weight:bold">${escapeHtml(k)}</dt><dd style="margin:0 0 8px">${escapeHtml(v)}</dd>`).join('')}</dl>` : '',
    ...(layout.links ?? []).map(
      (link) =>
        `<p style="margin:0 0 16px"><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a><br>Link address: <span style="word-break:break-all">${escapeHtml(link.url)}</span></p>`,
    ),
    ...(layout.closing ?? []).map(p),
  ].filter(Boolean);
  return [
    '<!doctype html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(layout.subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5">',
    '<main style="max-width:560px">',
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(layout.heading)}</h1>`,
    ...body,
    `<hr style="border:0;border-top:1px solid #cccccc;margin:24px 0 12px"><p style="margin:0;font-size:13px;color:#444444">${escapeHtml(NOTICE)}</p>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function build(layout: Layout, greeting: string | null = null): RenderedEmail {
  return { subject: layout.subject, text: toText(layout, greeting), html: toHtml(layout, greeting) };
}

const renderers: { [T in EmailTemplate]: (data: Record<string, unknown>) => RenderedEmail } = {
  email_verification: (d) =>
    build(
      {
        subject: 'Confirm your email address',
        heading: 'Confirm your email address',
        paragraphs: [`This address was used to create an account at ${BRAND}. Open the link below to confirm it. The link is single-use and time-limited.`],
        links: [{ label: 'Confirm your email address', url: d.link as string }],
        closing: ['If you did not create an account, ignore this message. No account is activated until the link is opened.'],
      },
      typeof d.name === 'string' ? `Hello ${d.name},` : null,
    ),
  password_reset: (d) =>
    build({
      subject: 'Reset your password',
      heading: 'Reset your password',
      paragraphs: [`A password reset was requested for your ${BRAND} account. Open the link below to choose a new password. The link is single-use and time-limited.`],
      links: [{ label: 'Choose a new password', url: d.link as string }],
      closing: ['If you did not request this, ignore this message. Your password stays the same until the link is used.'],
    }),
  order_confirmation: (d) =>
    build({
      subject: `Order confirmation ${d.orderId as string}`,
      heading: 'Order confirmation',
      paragraphs: [`This message confirms that ${BRAND} has recorded your order. It is a record of the order, not a shipping notice. A separate email with tracking details is sent when the order ships.`],
      details: [
        ['Order number', d.orderId as string],
        ['Order total', formatMoney(d.totalCents as number, d.currency as string)],
      ],
    }),
  order_shipped: (d) => {
    const details: [string, string][] = [
      ['Order number', d.orderId as string],
      ['Carrier', d.carrier as string],
      ['Tracking number', d.trackingNumber as string],
    ];
    return build({
      subject: `Order ${d.orderId as string} has shipped`,
      heading: 'Your order has shipped',
      paragraphs: [`Order ${d.orderId as string} has been handed to the carrier listed below.`],
      details,
      links: typeof d.trackingUrl === 'string' ? [{ label: 'Track this shipment', url: d.trackingUrl }] : [],
      closing: typeof d.trackingUrl === 'string' ? [] : ['No tracking link is available for this carrier; use the tracking number on the carrier\u2019s own site.'],
    });
  },
};

/**
 * Validates `data` for `template` and renders it. Throws EmailValidationError for an unknown template or bad data (so the
 * worker can fail a malformed stored row permanently).
 */
export function renderEmail(template: string, data: unknown): RenderedEmail {
  if (!isKnownTemplate(template)) throw new EmailValidationError('unknown template');
  const rendered = renderers[template](validateTemplateData(template, data));
  if (/[\r\n]/.test(rendered.subject)) throw new EmailValidationError('subject contains a line break');
  return rendered;
}

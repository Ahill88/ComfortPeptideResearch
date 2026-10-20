import type { ReactNode } from 'react';
import styles from './wallets.module.css';
import { badgeTone } from './format';
import { WALLET_SECTIONS } from './sections';
import type { ApiResult } from './api';

export const READ_ONLY_NOTICE = 'Read-only. Administrators cannot sign, move, or control customer wallets.';

export function ReadOnlyNotice() {
  return (
    <aside className={styles.readOnly} aria-label="Read-only notice">
      <span className={styles.readOnlyIcon} aria-hidden="true">Notice</span>
      <p style={{ margin: 0 }}>
        <strong>Read-only.</strong> Administrators cannot sign, move, or control customer wallets.
      </p>
    </aside>
  );
}

export function WalletsShell({ active, children }: { active: string; children: ReactNode }) {
  const section = WALLET_SECTIONS.find((candidate) => candidate.slug === active) ?? WALLET_SECTIONS[0];
  return (
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Helix and Field operations home">
          <span className="brand-mark">H/F</span>
          <span>Helix &amp; Field<small>Operations</small></span>
        </a>

        <nav className="nav" aria-label="Primary navigation">
          <a className="nav-link" href="/"><span>01</span>Overview</a>
          <a className="nav-link active" href="/wallets" aria-current="page"><span>02</span>Wallets</a>
        </nav>

        <div className="sidebar-footer">
          Read-only reporting
          <small>No signing or fund movement</small>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <p className="eyebrow">Workspace / wallets / {section.label}</p>
        </header>

        <div className={styles.heading}>
          <p className="eyebrow">Wallet operations</p>
          <h1>{section.title}</h1>
          <p className="subtitle">{section.description}</p>
        </div>

        <ReadOnlyNotice />

        <nav className={styles.tabs} aria-label="Wallet sections">
          {WALLET_SECTIONS.map((item) => (
            <a
              key={item.slug}
              href={item.href}
              className={`${styles.tab} ${item.slug === active ? styles.tabActive : ''}`}
              aria-current={item.slug === active ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div id="wallet-content">{children}</div>
      </section>
    </main>
  );
}

export function ApiErrorState({ result }: { result: Extract<ApiResult<unknown>, { ok: false }> }) {
  const title =
    result.reason === 'not-configured' ? 'Wallet reporting is not configured'
    : result.reason === 'unauthorized' ? 'Wallet reporting access was refused'
    : 'Wallet reporting is unavailable';
  return (
    <div className={`${styles.state} ${styles.stateError}`} role="alert">
      <h2>{title}</h2>
      <p>{result.message}</p>
      <p>No figures are displayed while the data source is unavailable.</p>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className={`${styles.state} ${styles.stateEmpty}`} role="status">
      <p>{children}</p>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`${styles.badge} ${styles[badgeTone(status)]}`}>{status}</span>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className={styles.mono}>{children}</span>;
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  numeric?: boolean;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  getKey,
  empty,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className={styles.tableRegion} role="region" aria-label={caption} tabIndex={0}>
      <table className={styles.table}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" className={column.numeric ? styles.num : undefined}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getKey(row)}>
              {columns.map((column) => (
                <td key={column.header} className={column.numeric ? styles.num : undefined}>{column.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function hrefWith(base: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

/** Forward-only cursor pager. `keep` carries other query params (filters, sibling cursors). */
export function Pager({
  base,
  cursorKey = 'cursor',
  current,
  next,
  keep = {},
  label,
}: {
  base: string;
  cursorKey?: string;
  current: string | undefined;
  next: string | null;
  keep?: Record<string, string | undefined>;
  label: string;
}) {
  return (
    <nav className={styles.pager} aria-label={`${label} pagination`}>
      {current ? <a className={styles.pagerLink} href={hrefWith(base, { ...keep, [cursorKey]: undefined })}>First page</a> : <span className={styles.pagerEnd}>First page</span>}
      {next ? <a className={styles.pagerLink} href={hrefWith(base, { ...keep, [cursorKey]: next })}>Next page</a> : <span className={styles.pagerEnd}>End of results</span>}
    </nav>
  );
}

export function StatusFilter({
  base,
  options,
  active,
  label,
  param = 'status',
}: {
  base: string;
  options: readonly string[];
  active: string | undefined;
  label: string;
  param?: string;
}) {
  return (
    <nav className={styles.filters} aria-label={label}>
      <span className={styles.filterLabel}>{label}</span>
      <a className={`${styles.filter} ${!active ? styles.filterActive : ''}`} href={base} aria-current={!active ? 'true' : undefined}>All</a>
      {options.map((option) => (
        <a
          key={option}
          className={`${styles.filter} ${active === option ? styles.filterActive : ''}`}
          href={hrefWith(base, { [param]: option })}
          aria-current={active === option ? 'true' : undefined}
        >
          {option}
        </a>
      ))}
    </nav>
  );
}

export function MetricCards({ items }: { items: Array<{ label: string; value: string; note?: string }> }) {
  return (
    <section className={styles.cards} aria-label="Summary">
      {items.map((item) => (
        <article className={`metric-card ${styles.card}`} key={item.label}>
          <p>{item.label}</p>
          <strong>{item.value}</strong>
          {item.note && <div>{item.note}</div>}
        </article>
      ))}
    </section>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className={styles.sectionTitle}>{children}</h2>;
}

export { styles as walletStyles };

const metrics = [
  { label: 'Gross sales', value: '$18,420', change: '+12.8%', note: 'vs. prior 7 days' },
  { label: 'Orders', value: '142', change: '+8.4%', note: 'vs. prior 7 days' },
  { label: 'Fulfillment SLA', value: '96.2%', change: '+1.7%', note: 'within 24 hours' },
  { label: 'Low stock', value: '03', change: 'Review', note: 'variants need attention' },
];

const orders = [
  { id: '#HF-10482', customer: 'M. Rodriguez', items: 'Recovery Stack, 2 items', total: '$248.00', status: 'Paid' },
  { id: '#HF-10481', customer: 'T. Nguyen', items: 'Foundation Protocol, 1 item', total: '$132.00', status: 'Packing' },
  { id: '#HF-10480', customer: 'A. Okafor', items: 'Performance Bundle, 3 items', total: '$310.00', status: 'Paid' },
];

const inventory = [
  { name: 'BPC-157', variant: '5 mg vial', stock: 84, state: 'Healthy' },
  { name: 'TB-500', variant: '10 mg vial', stock: 21, state: 'Watch' },
  { name: 'Ipamorelin', variant: '5 mg vial', stock: 8, state: 'Low' },
];

function Arrow() {
  return <span aria-hidden="true">→</span>;
}

export default async function Admin() {
  const developmentSessionEnabled =
    process.env.NODE_ENV === 'development' &&
    process.env.ADMIN_DEV_SESSION === 'enabled';
  const cookieStore = await cookies();

  // Production must integrate an identity provider that verifies an admin role
  // and MFA server-side before rendering any operational data or actions.
  if (!developmentSessionEnabled || cookieStore.get('admin_dev_session')?.value !== 'active') {
    redirect('/sign-in');
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Helix and Field operations home">
          <span className="brand-mark">H/F</span>
          <span>Helix &amp; Field<small>Operations</small></span>
        </a>

        <nav className="nav" aria-label="Primary navigation">
          <a className="nav-link active" href="#overview"><span>01</span>Overview</a>
          <a className="nav-link" href="#orders"><span>02</span>Orders <b>12</b></a>
          <a className="nav-link" href="#fulfillment"><span>03</span>Fulfillment</a>
          <a className="nav-link" href="#inventory"><span>04</span>Inventory <b>3</b></a>
          <a className="nav-link" href="#customers"><span>05</span>Customers</a>
          <Link className="nav-link" href="/wallets"><span>06</span>Wallets</Link>
        </nav>

        <div className="sidebar-footer">
          <span className="live-dot" /> Systems operational
          <small>Last sync: 2 minutes ago</small>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <p className="eyebrow">Tuesday, October 20</p>
          <div className="profile">
            <button className="notification" aria-label="View notifications">3</button>
            <span className="avatar">AS</span>
            <span className="profile-name">Andrew Silva<small>Operations admin</small></span>
          </div>
        </header>

        <div className="page-heading" id="overview">
          <div>
            <p className="eyebrow">Workspace / overview</p>
            <h1>Good morning, Andrew.</h1>
            <p className="subtitle">Here is the current pulse of your operation.</p>
          </div>
          <button className="export-button">Export report <Arrow /></button>
        </div>

        <section className="metrics" aria-label="Key metrics">
          {metrics.map((metric) => (
            <article className="metric-card" key={metric.label}>
              <p>{metric.label}</p>
              <strong>{metric.value}</strong>
              <div><span className={metric.change.startsWith('+') ? 'positive' : ''}>{metric.change}</span> {metric.note}</div>
            </article>
          ))}
        </section>

        <section className="dashboard-grid">
          <article className="panel orders-panel" id="orders">
            <div className="panel-header">
              <div><p className="eyebrow">Order desk</p><h2>Recent orders</h2></div>
              <a href="#orders">View all <Arrow /></a>
            </div>
            <div className="order-list">
              {orders.map((order) => (
                <div className="order-row" key={order.id}>
                  <div><strong>{order.id}</strong><span>{order.customer}</span></div>
                  <span className="order-items">{order.items}</span>
                  <strong>{order.total}</strong>
                  <span className={`status ${order.status.toLowerCase()}`}>{order.status}</span>
                </div>
              ))}
            </div>
          </article>

          <article className="panel fulfillment-panel" id="fulfillment">
            <div className="panel-header"><div><p className="eyebrow">Fulfillment</p><h2>Today&apos;s queue</h2></div><a href="#fulfillment">Open queue <Arrow /></a></div>
            <div className="queue-count"><strong>12</strong><span>orders ready to move</span></div>
            <div className="queue-bar"><i style={{ width: '72%' }} /></div>
            <div className="queue-details"><span><b>08</b> awaiting pick</span><span><b>04</b> packed</span></div>
            <p className="queue-note"><span className="amber-dot" /> Carrier collection at 4:30 PM</p>
          </article>

          <article className="panel inventory-panel" id="inventory">
            <div className="panel-header"><div><p className="eyebrow">Stock watch</p><h2>Inventory health</h2></div><a href="#inventory">Manage <Arrow /></a></div>
            <div className="inventory-list">
              {inventory.map((item) => (
                <div className="inventory-row" key={item.name}>
                  <div className={`product-dot ${item.state.toLowerCase()}`} />
                  <div><strong>{item.name}</strong><span>{item.variant}</span></div>
                  <div className="stock"><strong>{item.stock}</strong><span className={`state ${item.state.toLowerCase()}`}>{item.state}</span></div>
                </div>
              ))}
            </div>
          </article>

          <article className="access-card" id="customers">
            <div className="lock-icon" aria-hidden="true">⌑</div>
            <div><p className="eyebrow">Restricted workspace</p><h2>Access control is active.</h2><p>Order editing, catalog publishing, and payout changes require an assigned operational role and verified multi-factor authentication.</p></div>
            <a href="#overview">Review permissions <Arrow /></a>
          </article>
        </section>
      </section>
    </main>
  );
}
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

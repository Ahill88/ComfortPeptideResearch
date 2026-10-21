import { Shell } from '../../components/console/shell';
import { InventoryManager } from '../../components/operations/inventory-manager';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import type { InventoryItem, Page } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Inventory - Helix & Field Operations' };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireSession();
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.slice(0, 100) : '';
  const low = params.lowStockOnly === 'true';
  const result = await callApi<Page<InventoryItem>>('/admin/inventory', { query: { q, lowStockOnly: String(low), limit: 25 } });
  expireOnUnauthorized(result);
  return <Shell auth={auth} active="inventory">
    <div className="page-head"><div><h1>Inventory</h1><p>Product-level stock, adjustments and movement history.</p></div></div>
    <p className="msg msg-info">On hand is the sellable count. Unpaid reservations are already deducted; reserved units are informational and must not be subtracted again.</p>
    <form className="filters" action="/inventory">
      <div className="field"><label htmlFor="inventory-q">Search SKU or product name</label><input id="inventory-q" name="q" type="search" defaultValue={q} maxLength={100} /></div>
      <label className="check"><input type="checkbox" name="lowStockOnly" value="true" defaultChecked={low} />Low stock only</label>
      <button type="submit" className="btn-primary">Apply filters</button>
    </form>
    {result.ok ? <InventoryManager key={`${q}:${low}`} initial={result.data} q={q} lowStockOnly={low} isOwner={auth.admin.role === 'OWNER'} /> : <p className="msg msg-error" role="alert">Inventory could not be loaded: {result.message}</p>}
  </Shell>;
}

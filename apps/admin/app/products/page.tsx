import { Shell } from '../../components/console/shell';
import { ProductsManager } from '../../components/coa/products-manager';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import type { AdminProduct } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Products - Helix & Field Operations' };

export default async function Products() {
  const auth = await requireSession();
  const result = await callApi<{ items: AdminProduct[] }>('/admin/catalog/products');
  expireOnUnauthorized(result);
  return (
    <Shell auth={auth} active="products">
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Whether each product is active in the storefront. Owners publish and unpublish.</p>
        </div>
      </div>
      {!result.ok ? (
        <p className="msg msg-error" role="alert">The products could not be loaded: {result.message}</p>
      ) : (
        <ProductsManager initial={result.data.items} isOwner={auth.admin.role === 'OWNER'} />
      )}
    </Shell>
  );
}

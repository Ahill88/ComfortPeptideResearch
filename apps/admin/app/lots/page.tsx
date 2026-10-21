import { Shell } from '../../components/console/shell';
import { LotRegister } from '../../components/coa/lot-register';
import { callApi } from '../../lib/server/api';
import { expireOnUnauthorized, requireSession } from '../../lib/server/session';
import { ENTITY_ID } from '../../lib/coa';
import type { AdminLotSummary, AdminProduct } from '../../lib/types';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Lots & COAs - Helix & Field Operations' };

const pick = (value: string | string[] | undefined): string => (typeof value === 'string' ? value : '');

export default async function Lots({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireSession();
  const params = await searchParams;
  const requestedProduct = pick(params.productId);
  const productId = ENTITY_ID.test(requestedProduct) ? requestedProduct : '';
  const q = pick(params.q).trim().slice(0, 100);

  const [products, lots] = await Promise.all([
    callApi<{ items: AdminProduct[] }>('/admin/catalog/products'),
    callApi<{ items: AdminLotSummary[]; nextCursor: string | null }>('/admin/lots', { query: { productId, q, limit: 25 } }),
  ]);
  expireOnUnauthorized(products);
  expireOnUnauthorized(lots);

  return (
    <Shell auth={auth} active="lots">
      <div className="page-head">
        <div>
          <h1>Lots &amp; COAs</h1>
          <p>Certificates of analysis from the outside lab, managed per lot.</p>
        </div>
      </div>
      {!products.ok && <p className="msg msg-error" role="alert">Products could not be loaded, so the filter and the New lot form are unavailable: {products.message}</p>}
      {!lots.ok ? (
        <p className="msg msg-error" role="alert">The lot register could not be loaded: {lots.message}</p>
      ) : (
        <LotRegister
          key={`${productId}|${q}`}
          products={products.ok ? products.data.items : []}
          productId={productId}
          q={q}
          initialItems={lots.data.items}
          nextCursor={lots.data.nextCursor ?? null}
        />
      )}
    </Shell>
  );
}

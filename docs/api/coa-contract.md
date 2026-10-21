# COA verification: FIXED CONTRACT (source of truth for API, storefront and admin work)

Outside-lab certificates of analysis (COAs) are managed per LOT. Admins upload the lab's PDF + the lab's reported fields; an OWNER publishes a
version (it supersedes the previous one); the PDF's SHA-256 is anchored on Solana in a Memo; anyone can verify a lot publicly.
**What an anchor proves:** this exact document existed unchanged at that time and was linked to this lot by us. **It does NOT prove the lab's
results are true.** All copy must say "tamper-evident, publicly checkable record", never "blockchain-verified purity".

## Data (Prisma, already migrated): Coa, CoaFile, CoaAnchor (see schema.prisma, migration 20261021200000_coa_records)
- Lot code for COA lots matches /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/ (no ':' so the memo is unambiguous).
- Coa.version is 1,2,3... per lot. Exactly one PUBLISHED per lot; publishing a new one marks the old PUBLISHED as SUPERSEDED (same transaction).
- A REVOKED coa stays downloadable and visible (with its reason); revoking the PUBLISHED one leaves the lot with no current COA.
- Publishing syncs Lot.purity = purityPercent, Lot.coaKey = `coa/<coaId>`, Lot.releasedAt unchanged (existing readers keep working).

## Anchor memo (Solana Memo program v2 `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`), UTF-8, exactly:
`helix-coa:v1:<kind>:<lotCode>:<version>:<sha256hex-lowercase>` with kind = `publish` | `revoke`.
One CoaAnchor row per (coa, kind). The transaction's fee payer/signer is the COA publisher key. An anchor is public ONLY when status = CONFIRMED
(finalized and the on-chain memo re-read equals the expected memo and the signer is the configured publisher).

## PUBLIC API (no auth, rate limited, `Cache-Control: public, max-age=30`)
- `GET /v1/public/lots/:lotCode` -> 200 PublicLotRecord | 404 `{message:'Lot not found.'}` (404 also for lots with only DRAFT coas or none)
  PublicLotRecord = { lotCode, product:{slug,name}|null (null unless the product is active), status:'current'|'revoked',
    current: PublicCoa|null, versions: PublicCoa[] (non-draft, newest first) }
  PublicCoa = { version:number, status:'published'|'superseded'|'revoked', lab:{name,reportId}, testedAt:'YYYY-MM-DD', method:string,
    purityPercent:number, notes:string|null, file:{name,sizeBytes,sha256,url:'/v1/public/lots/<lotCode>/coa/<version>.pdf'},
    publishedAt:ISO|null, revokedAt:ISO|null, revokeReason:string|null, anchors:{publish:PublicAnchor|null, revoke:PublicAnchor|null} }
  PublicAnchor = { network:'solana-devnet'|'solana-mainnet', txSignature, slot:number|null, blockTime:ISO|null, memo:string, explorerUrl:string }
  lot `status` = 'current' when a PUBLISHED coa exists, otherwise 'revoked'.
- `GET /v1/public/lots/:lotCode/coa/:version.pdf` -> the PDF (published, superseded and revoked versions; never drafts), headers: Content-Type application/pdf,
  Content-Disposition inline, X-Content-Type-Options nosniff, ETag = sha256, Cache-Control public max-age=300.
- `GET /v1/public/coa/by-hash/:sha256` (64 hex, case-insensitive) -> 200 `{found:boolean, matches:[{lotCode, version, status:'published'|'superseded'|'revoked'}]}`; 400 for a malformed hash.
- `GET /v1/public/anchor-info` -> `{network:'solana-devnet'|'solana-mainnet'|null, publisher:string|null, memoProgramId, memoFormat:'helix-coa:v1:<kind>:<lotCode>:<version>:<sha256>', anchoringEnabled:boolean}`
  (publisher = the public key that signs anchors, so third parties can check who wrote a memo).
- Existing `GET /v1/products/:slug` lot objects gain `coaPublished: boolean` (true when the lot has a PUBLISHED coa). When env REQUIRE_PUBLISHED_COA=true the
  `lots` array contains ONLY lots with a published coa and `POST /v1/orders` rejects lots without one (400 `Unavailable product in order`). Default false.

## ADMIN API (`/v1/admin`, `Authorization: Bearer <admin session>`; roles: STAFF can create lots and DRAFT uploads; OWNER-only where marked)
- `GET /admin/catalog/products` -> `{items:[{id,sku,slug,name,active,priceCents,inventory,lotCount,publishedCoaLotCount}]}`
- `POST /admin/catalog/products/:id/publish` (OWNER) -> 200 product; sets active=true; 409 `Product has no lot with a published COA.` when REQUIRE_PUBLISHED_COA=true and none
- `POST /admin/catalog/products/:id/unpublish` (OWNER) -> 200 product; sets active=false
- `GET /admin/lots?productId=&q=&limit=25&cursor=` -> `{items:[AdminLotSummary], nextCursor|null}`;
  AdminLotSummary = {id, code, productId, productName, productSku, releasedAt, currentCoaVersion:number|null, coaStatus:'none'|'draft'|'published'|'revoked', anchorStatus:'none'|'pending'|'confirmed'|'failed'}
  (coaStatus/anchorStatus describe the lot's newest relevant coa: published if any, else the newest draft/revoked; anchorStatus of its PUBLISH anchor)
- `POST /admin/lots {productId, code}` -> 201 AdminLotSummary (placeholder Lot.purity=0, coaKey='PENDING-NO-COA'; 409 duplicate code; 400 bad code)
- `GET /admin/lots/:id` -> `{lot:AdminLotSummary, coas:AdminCoa[]}` (newest version first);
  AdminCoa = {id, lotId, version, status:'DRAFT'|'PUBLISHED'|'SUPERSEDED'|'REVOKED', labName, labReportId, testedAt:'YYYY-MM-DD', method, purityPercent:number, notes|null,
    file:{name,sizeBytes,sha256}, createdBy:{name}|null, createdAt, publishedBy:{name}|null, publishedAt|null, revokedBy:{name}|null, revokedAt|null, revokeReason|null,
    anchors:{publish:AdminAnchor|null, revoke:AdminAnchor|null}};  AdminAnchor = {status:'PENDING'|'CONFIRMED'|'FAILED', network, txSignature|null, slot|null, blockTime|null, attempts:number, error|null, memo, explorerUrl|null}
- `POST /admin/lots/:id/coas` multipart/form-data fields: `file` (PDF only: magic bytes `%PDF-`, <= 10 MB), `labName` (1-120), `labReportId` (1-120), `testedAt` (YYYY-MM-DD, not in the future),
  `method` (1-120, e.g. HPLC), `purityPercent` (0-100, <= 2 decimals), `notes` (<= 1000, optional) -> 201 AdminCoa (DRAFT, next version); the SHA-256 is computed server-side;
  the same sha256 already present on the same lot is a 409.
- `GET /admin/coas/:id/file` -> the PDF (any status, for admin review)
- `POST /admin/coas/:id/publish` (OWNER) body `{confirmSha256}` (must equal the stored hash, forcing a real review) -> 200 AdminCoa. Atomic: supersedes the previous PUBLISHED, syncs Lot, then requests the PUBLISH anchor (fail-soft: the COA stays published if anchoring is unavailable).
- `POST /admin/coas/:id/revoke` (OWNER) body `{reason: 1-500}` -> 200 AdminCoa (status REVOKED; requests the REVOKE anchor; a revoked published coa leaves the lot with no current COA)
- `DELETE /admin/coas/:id` -> 204 (DRAFT only; OWNER or the creator)
- `POST /admin/coas/:id/anchor/retry` (OWNER) body `{kind:'PUBLISH'|'REVOKE'}` -> 200 AdminCoa
Errors: 400 validation, 401/403 auth, 404, 409 `{message}`; every mutation writes an AdminAuditEvent (action `coa.upload|publish|revoke|delete|anchor.retry`, `lot.create`, `product.publish|unpublish`).

## Anchoring config (separate from the payment chain: anchoring on mainnet must NOT enable payments)
`COA_ANCHOR_NETWORK` = `solana-devnet` (default) | `solana-mainnet`; `COA_ANCHOR_RPC_URL` (required for mainnet, explicit; devnet defaults to the public devnet endpoint);
`COA_ANCHOR_ENABLED` = `true` to attempt anchoring (default false = COAs publish without anchors, anchorStatus none). The publisher key is NEVER in the repo: it is bound under the
`COA_PUBLISHER_SIGNER` provider token (KMS/HSM in production; the dev launcher binds a throwaway devnet key), exactly like the fee-payer signer.

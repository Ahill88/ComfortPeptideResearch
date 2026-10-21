# Certificate-of-analysis (COA) verification

Outside-lab certificates of analysis are managed per **lot**. An admin uploads the lab's PDF and the lab's reported fields, an
**OWNER** publishes a version (which supersedes the previous one), and anyone can look the lot up publicly and check the PDF
against the record and, when anchoring is on, against a Solana transaction. The field-level API is fixed in
[`coa-contract.md`](./coa-contract.md); this page explains what it means and how to use and verify it.
Source: `apps/api/src/coa/` (anchoring: `apps/api/src/coa/anchor/`).

## What it proves, and what it does not

A published record is a **tamper-evident, publicly checkable record**. With an anchor it shows that:

- this exact document (its SHA-256) existed, unchanged, at the time of the transaction, and
- Helix & Field linked it to this lot and version (the memo names both) and signed that statement with its publisher key.

It does **not** prove that the lab's results are true, that the lab is competent, or that the vial in your hand came from that lot.
The numbers are the lab's; we publish them as reported. Do not describe this as "blockchain-verified purity".

Without an anchor (anchoring is off, pending or failed) the record is still published and the PDF hash is still shown, but there is
no independent timestamp. Only anchors that were re-read from the chain and matched the expected memo and signer are shown publicly.

## Public API

No authentication, rate limited (per client IP, own `public` bucket, `THROTTLE_PUBLIC_LIMIT`, default 180/min), JSON answers carry
`Cache-Control: public, max-age=30`. Errors are `no-store`.

```bash
# The record of a lot: current version, every non-draft version (newest first), confirmed anchors.
# 404 {"message":"Lot not found."} for unknown lots and for lots that only have drafts.
curl -s https://api.example.com/v1/public/lots/BPC157-2026-01

# The PDF of one version (published, superseded or revoked; never a draft). ETag is the quoted SHA-256; If-None-Match gives 304.
curl -sS -o coa-v2.pdf https://api.example.com/v1/public/lots/BPC157-2026-01/coa/2.pdf
curl -sI -H 'If-None-Match: "<sha256>"' https://api.example.com/v1/public/lots/BPC157-2026-01/coa/2.pdf   # HTTP 304

# Which lot versions carry a file with this hash (64 hex, any case). 400 if malformed. found=false when nothing matches.
curl -s https://api.example.com/v1/public/coa/by-hash/$(sha256sum coa-v2.pdf | cut -d' ' -f1)

# Who signs anchors, on which network, and the memo format.
curl -s https://api.example.com/v1/public/anchor-info
```

`PublicLotRecord` (see the contract for every field): `lotCode`, `product` (`{slug,name}`, or `null` when the product is not active),
`status` (`current` while a published version exists, else `revoked`), `current`, `versions[]`. Each version has `version`, `status`
(`published | superseded | revoked`), `lab`, `testedAt`, `method`, `purityPercent`, `notes`, `file {name,sizeBytes,sha256,url}`,
`publishedAt`, `revokedAt`, `revokeReason` and `anchors {publish, revoke}` (each `null` unless CONFIRMED). A revoked version stays
downloadable and visible, with its reason.

The storefront catalog also gains `coaPublished: boolean` on every lot object of `GET /v1/products` and `GET /v1/products/:slug`.

## How a third party verifies independently

You need nothing from us except the public record and a Solana explorer or RPC node.

1. **Download the PDF** from `file.url` (or the lab's original if you hold it).
2. **Hash it yourself** and compare with the record: `sha256sum coa-v2.pdf` must equal `file.sha256` (the `ETag` of the PDF response is that
   hash in quotes). `GET /v1/public/coa/by-hash/<hash>` answers which lot and version carry that exact file.
3. **Look up the anchor transaction** (`anchors.publish.txSignature`, link in `explorerUrl`) on the network named in `network`.
   The transaction must contain one instruction to the Memo program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
4. **Compare the memo.** It must be exactly `helix-coa:v1:<kind>:<lotCode>:<version>:<sha256>` (UTF-8, `kind` = `publish` or `revoke`, hash
   lower-case hex): `helix-coa:v1:publish:BPC157-2026-01:2:<the sha256 you computed>`. A revoke anchor has `revoke` as the kind.
5. **Compare the signer.** The transaction's fee payer / first signer must be the `publisher` key from `GET /v1/public/anchor-info`.
   The block time is when the document was known to exist.

If any step differs (hash, memo text, lot, version, signer) the record must not be trusted.

## Publish and revoke workflow (back office)

All routes are under `/v1/admin` and need an admin session. STAFF can create lots and upload DRAFTs; everything marked OWNER needs an owner.

1. `POST /admin/lots {productId, code}` creates the lot (code `^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$`, no `:`; placeholder purity 0 and
   `coaKey` `PENDING-NO-COA`, like the seed).
2. `POST /admin/lots/:id/coas` (multipart: `file`, `labName`, `labReportId`, `testedAt`, `method`, `purityPercent`, `notes?`) stores a
   **DRAFT**. The server checks the `%PDF-` magic bytes and the 10 MB limit (never the client's MIME type or file name), computes the
   SHA-256 and numbers the version (1, 2, 3 ... per lot). The same file twice on one lot is a 409. A lot holds at most 50 drafts.
3. `GET /admin/coas/:id/file` shows the stored PDF to the reviewer. A DRAFT is never public.
4. **OWNER** `POST /admin/coas/:id/publish {confirmSha256}`: the hash must equal the stored one (so the owner really looked at it). One
   transaction marks the previous PUBLISHED as SUPERSEDED, publishes this one and syncs the lot (`purity`, `coaKey = coa/<id>`). A double
   click is one 200 and one 409. After the commit the PUBLISH anchor is requested; if anchoring is down the COA stays published and the
   anchor can be retried with `POST /admin/coas/:id/anchor/retry {kind}` (OWNER).
5. **OWNER** `POST /admin/coas/:id/revoke {reason}` works on PUBLISHED or SUPERSEDED versions. The version stays visible with the reason and
   a REVOKE anchor is requested. Revoking the published one leaves the lot with **no current COA** (`status: "revoked"` publicly) and
   resets the lot's legacy `purity`/`coaKey` to the "no data" placeholders so existing readers do not keep showing a revoked result.
6. `DELETE /admin/coas/:id` removes a DRAFT (OWNER, or the admin who uploaded it).

Every mutation writes an `AdminAuditEvent` (`coa.upload|publish|revoke|delete|anchor.retry`, `lot.create`, `product.publish|unpublish`)
with ids, version and hash only (no file bytes, no customer data).

Products: `POST /admin/catalog/products/:id/publish|unpublish` (OWNER). With `REQUIRE_PUBLISHED_COA=true`, publishing needs at least one
lot with a published COA (`409 Product has no lot with a published COA.`).

## `REQUIRE_PUBLISHED_COA`

Only the exact string `true` turns it on; default off so the preview seed (placeholder lots without COAs) keeps working. When on:

- `GET /v1/products` and `GET /v1/products/:slug` list only lots that currently have a published COA,
- `POST /v1/orders` rejects any line whose lot has none with `400 Unavailable product in order` (an existing order replayed with the same
  idempotency key is returned as before),
- publishing a product requires such a lot.

**Production must set it to `true` once real COAs exist.** Revoking the published COA of a lot takes that lot off sale immediately.

## Anchoring configuration

Separate from the payment chain: `COA_ANCHOR_ENABLED`, `COA_ANCHOR_NETWORK`, `COA_ANCHOR_RPC_URL`, and the `COA_PUBLISHER_SIGNER`
provider token (KMS/HSM in production). See [`coa-contract.md`](./coa-contract.md). The public `anchor-info` endpoint reports the
network and the public key that signs, read from the `COA_ANCHOR_INFO` provider (`apps/api/src/coa/coa-anchor-info.ts`).

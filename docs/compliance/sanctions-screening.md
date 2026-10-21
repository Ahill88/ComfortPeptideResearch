# Sanctions address screening

**What this is:** an exact-match check of a customer's wallet address against the "Digital Currency Address" entries of the public
OFAC Specially Designated Nationals (SDN) list, at four points in the API.

**What this is not:** it is not name screening, not country/IP screening, not transaction monitoring, not a complete OFAC (or any other)
compliance programme, and it is not legal advice. It supports a programme; it does not replace one. Counsel must decide what the business
needs beyond this (see "Not covered").

Code: `apps/api/src/compliance/sanctions/**`, port in `apps/api/src/wallet/transfers/compliance-screen.ts` (token `COMPLIANCE_SCREEN`).

## Behaviour

| Surface | Where | What is screened |
| --- | --- | --- |
| Wallet link | `WalletService.associateWallet` (after the ownership proof, also on a replay) | the address being linked |
| On-ramp | `OnRampService` (new intent and re-quote), before any provider call | the customer's linked wallet (the destination) |
| Transfer | `TransfersService.prepare` | the customer's wallet and the destination address |
| Checkout | `CheckoutService.prepare`, before any reservation | the paying wallet |

* A listed address is refused with HTTP 403 `{"message":"This wallet cannot be used."}`. The message is generic and never mentions a list.
* Each refusal writes a `WalletAuditEvent` with `action = SANCTIONS_BLOCKED` and `detail = {"surface": "wallet_link" | "onramp" | "transfer" | "checkout"}`. The address is not stored in that event.
* Matching is exact on the address string against **every** currency in the list (a listed Bitcoin or Tron address does not "belong" to a different chain). EVM-style addresses (`0x` + 40 hex) are also compared case-insensitively because checksum casing is cosmetic. Base58 addresses (Solana, Tron, Bitcoin) are case-sensitive and never match case-insensitively.
* Until a list has been loaded successfully once ("never loaded"): `development` and `test` let the request through and log a warning (at most once a minute); every other runtime, including an unset or unknown `NODE_ENV`, answers 503 `{"message":"Compliance screening is not ready."}` at all four surfaces. A database error while screening is also 503, never "allowed". The decision uses `isNonProductionRuntime` (`config/runtime.ts`).
* `SANCTIONS_SCREENING=off` is honoured only in `development`/`test`. Elsewhere it is ignored and a startup warning is logged.
* After the first successful load, every runtime enforces the list. A later failed refresh keeps the last good list in force.

## Data source (verified 2026-10-21)

Fetched with `curl` from this machine and inspected:

* Official site: OFAC "Sanctions List Service" (`https://ofac.treasury.gov/sanctions-list-service`), which publishes the SDN list in an Advanced format and "Legacy Data Formats".
* `https://www.treasury.gov/ofac/downloads/sdn.xml` answers `302` to `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn.xml`, which answers `302` to a short-lived signed object-storage URL (`...s3.us-gov-west-1.amazonaws.com/Published/...`, `X-Amz-Expires=3600`) and then `200`, `Content-Type: text/xml`, `Content-Disposition: attachment; filename="sdn.xml"`, 29,245,041 bytes, no compression.
* **Default `SANCTIONS_LIST_URL`:** `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML` (same file; `SDN.XML` and `sdn.xml` both worked). The fetcher follows redirects by hand (max 5, https only).
* The response carries a `Digest: sha-256<hex>` header (hex, not the base64 form of RFC 3230). The SHA-256 of the downloaded bytes equalled it (`421c5f6e...b5a5e08` for the 2026-10-21 publication), and the same value is stored in `SanctionsListRun.sha256` by the live run.
* Format: the legacy XML export, root `<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">`, header `<publshInformation>` (sic) with `Publish_Date` and `Record_Count` (19,471), then one `<sdnEntry>` per record with `uid`, `lastName`, optional `firstName`, `sdnType`, `programList`, `akaList`, `addressList`, and `idList`.
* A digital currency address is an `<id>` inside `<idList>`: `<idType>Digital Currency Address - XBT</idType><idNumber>ADDRESS</idNumber>`, optionally followed by `idCountry` / `issueDate` / `expirationDate`. Other IDs (passport, "Secondary sanctions risk:" ...) share the element and are ignored.
* What the file held that day (counted independently with `grep`/a throw-away script and then by the shipped parser; both agree): 1,066 digital currency ID entries, 1,050 unique address strings (the same address is listed under several entries), 19,471 `sdnEntry` records, none rejected by the charset rule. By suffix: XBT 534, TRX 261, ETH 120, USDT 94, LTC 14, XMR 11, BCH 7, DASH 5, ZEC 4, **SOL 4**, USDC 2 (these two are `0x` EVM-style), DOGE 2, and one each of XVG, XRP, ETC, BTG, BSV, BSC, BNB, ARB. Every address is 33 to 95 ASCII letters and digits. ETH/USDT-on-EVM entries are a mix of lower-case and mixed-case (checksum) forms, which is why EVM-style addresses are compared case-insensitively.
* The CSV export (`sdn.csv`) was also downloaded and **not** used: it had 106 lines mentioning digital currency against 1,066 ID entries in the XML (the IDs sit in a free-text remarks column there).
* End-to-end check against the real URL with this code: download and parse about 8 s, 1,050 addresses stored, a sample of real addresses all matched, an upper-cased EVM address matched, the 4 SOL rows were stored with `currency = SOL`.

The fixtures under `apps/api/src/compliance/sanctions/__tests__/fixtures` copy only the **structure** of that file. Names, uids and addresses in them are invented; no real list entry is stored in the repository.

## Ingestion

* `fetchSdnList` streams the body (size cap 200 MB on decoded bytes, one 60 s deadline covering redirects and body), hashes it, and feeds it to a bounded scanner (`sdn-xml.parser.ts`). The scanner is not an XML parser: it cuts `<sdnEntry>` blocks out of a sliding buffer (an entry larger than 262,144 characters is dropped; the largest real entry is about 26,000) and reads a fixed set of tags with regular expressions. Nothing is evaluated, no entity beyond the five predefined ones and numeric references is expanded, nothing is fetched. A truncated file (no closing `</sdnList>`) or a page with no `sdnEntry` fails the run.
* An address is kept only if it is 16 to 128 ASCII letters/digits. Anything else is counted, dropped and logged as a count (never the value).
* A run is recorded in `SanctionsListRun` (`RUNNING` while it works, then `OK` or `FAILED`, `entryCount`, `sha256`, redacted `error`). On success one transaction deletes the previous `SanctionsAddress` rows and inserts the new ones (unique `(source, address)`, duplicates in the file collapse to one); readers see the old set until commit. On any failure nothing is replaced.
* Plausibility: an empty result always fails. A result smaller than 50% of the last successful run fails unless the OWNER endpoint is called with `{"force": true}`. The first ever run has no baseline.
* Failure reasons stored and shown to admins are fixed texts ("The list source answered HTTP 503.", "The list download timed out." ...): no URL, query string, address or provider text.
* Logs carry counts only (`Sanctions list refreshed: N addresses (previously M); ...`). No address is logged at any level.

## Scheduling

* `SANCTIONS_REFRESH_HOURS` (default 24; `0` turns the automatic job off, startup run included; whole numbers up to 2160). The job wakes on the next event-loop tick after boot (never delays boot) and then every 15 minutes (or the interval if shorter). A wake-up downloads only if the last successful run is older than the interval and no failure happened in the last 30 minutes, so a restart loop or several instances do not hammer the source.
* Single flight: one run per process (callers share it) and one per database (a claim taken under a transaction-level advisory lock; a `RUNNING` row blocks others; a `RUNNING` row older than 5 minutes is treated as crashed).
* In `NODE_ENV=test` the automatic job does not start unless `SANCTIONS_REFRESH_IN_TEST=true` (test suites boot the app often and must not call the network).
* With `SANCTIONS_REFRESH_HOURS=0` and an empty database, a production-like runtime fails closed (503) until an OWNER refreshes by hand.

## Admin API (`/v1/admin`, admin session)

* `GET /admin/compliance/sanctions` (any active admin) returns `{source, lastRun: {fetchedAt, entryCount, status, error|null} | null, addressCount}`. `source` is the URL without credentials, query or fragment. `lastRun` is the latest `OK`/`FAILED` run.
* `POST /admin/compliance/sanctions/refresh` (OWNER) body `{ "force"?: boolean }` returns 200 with the same shape, or 503 with the redacted reason (failed, implausible, or another refresh running); the previous data stays. Every call is audited as `sanctions.refresh` with `{outcome, entryCount, force, reason}`, never an address.

## Not covered (decide with counsel)

* **People and places:** no name, alias, date of birth, address, country or IP screening of customers or shipping addresses. The SDN `akaList`, `addressList` and other lists (OFAC Consolidated/non-SDN, UK, EU, UN, others) are not ingested.
* **Only addresses that are already published.** A wallet that belongs to a listed person but is not listed, or that was funded by listed wallets, is not detected. No chain analytics, no clustering, no risk scoring.
* **Only these four moments.** Not screened: incoming deposits from a counterparty wallet, the signing/submit steps after prepare (a message prepared before an address was listed can still be submitted), refunds to a previously linked wallet, `mockComplete` in the sandbox, and wallets already linked until they next act at a screened surface. The screen is address-in, verdict-out; adding a call site is one line (`refuseIfSanctioned`).
* **Freshness:** at best as fresh as the last successful run (default daily); OFAC can list an address between runs.
* **Format risk:** the parser is written against the legacy XML as it looked on 2026-10-21. A format change fails the run (no entries / truncated / implausible) and keeps the old list, but someone has to notice (`GET /admin/compliance/sanctions` shows `FAILED`; there is no alerting here). The `SDN_ADVANCED` format was not examined.
* **Source availability and terms:** the default URL is Treasury's public endpoint; this code has no agreement with it, no mirror and no retry beyond the schedule.
* **Blocking vs rejecting, reporting and record-keeping obligations** that apply when a listed party is identified (for example blocking property and reporting) are legal questions this code does not address; it only refuses and records the surface.
* No automated test reaches the real Treasury server. The live check above was manual and one-off.

## Operations

* Production: leave `SANCTIONS_SCREENING` unset or `enforce`; keep `SANCTIONS_REFRESH_HOURS` at 24 or lower; confirm after deploy that `GET /v1/admin/compliance/sanctions` shows an `OK` run and a plausible `addressCount` (about 1,000 on 2026-10-21).
* If the source is unreachable at first boot in production, wallet link, on-ramp, transfer and checkout answer 503 until an `OK` run exists. That is intended.
* Tests: unit suites need no database; `sanctions.integration.test.ts` needs `TEST_DATABASE_URL` on your own scratch schema and empties `SanctionsAddress`/`SanctionsListRun` in it.

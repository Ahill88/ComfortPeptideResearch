# Helix & Field Platform

Direct-to-consumer storefront and modular commerce API for legally marketable research-use-only materials. The platform does not disguise merchant activity or bypass payment-provider controls.

## Local development

1. Copy `.env.example` to `.env` and populate secrets through a secret manager outside local development.
2. Start dependencies with `docker compose up postgres redis`.
3. Install dependencies with `npm install`.
4. Generate the database client: `npm run prisma:generate --workspace=@helix-field/api`.
5. Start the storefront: `npm run dev`. Start the API separately: `npm run dev:api`.

The storefront is at `http://localhost:3000`; API documentation is at `http://localhost:3001/docs`.

## Payment controls

The payment domain creates explicit `solana-usdc` intents and records an immutable-style double-entry ledger pair only after on-chain verification. The worker is deliberately disabled by default. A production Solana verifier must validate transaction finality, USDC mint, recipient treasury address, amount, and replay status before setting `PAYMENT_VERIFICATION_MODE=live`.

Future fiat processors belong behind an approved adapter and must receive accurate product, merchant, and transaction information.

## Production notes

Use managed PostgreSQL, Redis, object storage for certificates of analysis, an approved secret manager, and an authenticated Solana RPC provider. Add authenticated customer sessions, tax/address controls, inventory reservation, fulfillment carrier adapters, audit retention, and security review before accepting live transactions.

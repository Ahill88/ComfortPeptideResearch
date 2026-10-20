# Security controls

- Keep production secrets in a managed secret store; `.env` is local only.
- Enforce authenticated, role-based access and MFA for administrators before enabling operations routes.
- Use idempotency keys and database transactions around settlement, refunds, inventory reservations, and fulfillment transitions.
- Verify signed webhooks and Solana transaction finality server-side.
- Do not store card data or customer wallet private keys.

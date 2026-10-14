# yours Stablecoin Payment Handler

Handler: `io.github.mameta29.yours.stablecoin`, instance ID: `yours-stablecoin`.
UCP: `2026-08-25`. Settlement network: `eip155:80002` (Polygon Amoy).

This handler uses AP2 v0.2 for owner consent and the x402 v2 exact / ERC-7710 transfer method for settlement. It requires the `yours.purchase` extension: redemption must pass through the immutable YoursPurchaseGate, so a generic facilitator which directly redeems arbitrary delegations cannot settle this handler. The integration does not claim support by Coinbase's hosted facilitator.

1. Negotiate the UCP profile, create a checkout, and verify its detached merchant authorization.
2. Produce a closed AP2 checkout/payment mandate from the owner's open mandates. For the hosted Gemini connection, `/api/agent/present` asks the private AP2 holder to verify and present the owner-authorized task. An external agent uses its own enrolled P-256 holder.
3. Complete the checkout using `payment.instruments[0]` with `id` equal to the authorized instrument, `handler_id: yours-stablecoin`, `type: stablecoin`, `selected: true`, and `credential: {type: yours_ap2, mandate_id: UUID}`. Include the two real signed mandates in `ap2.checkout_mandate` and `ap2.payment_mandate`, plus `If-Match` and `Idempotency-Key` headers.
4. HTTP 202 / `complete_in_progress` reserves the budget and inventory and consumes the single-use AP2 task. It does not indicate payment success. The response's `yours.intent_id` identifies the payment resource `/api/agent/payments/{id}`.
5. Request that resource. Once the private worker has prepared a signed, order-specific delegation, HTTP 402 and the base64 JSON `PAYMENT-REQUIRED` header advertise the exact amount, token, recipient and Gate. The enrolled agent obtains its signed child delegation through `/api/agent/payments/{id}/authorization`. This endpoint uses the same agent authentication and only serves that agent's authorized task.
6. Retry the payment resource with a base64 JSON `PAYMENT-SIGNATURE` matching the advertised requirements and the `yours.purchase` extension. Changes to any bound field are rejected. HTTP 202 means settlement is still pending; poll the same resource. Funds are not sent until acceptance.
7. Only after five canonical-chain confirmations and matching Gate payment events does HTTP 200 return `PAYMENT-RESPONSE: base64({success:true,transaction,network,payer,amount})` and the UCP order. A timeout is not a failed payment. The worker recovers using the same persisted raw transaction and hash. Failed/revoked orders never receive a successful settlement header.

All agent routes require the enrolled bearer credential. A connection pause prevents new acceptance. Existing signed transactions remain reconcilable. Normal funds stay in the owner wallet until the atomic transfer; neither the LLM nor the agent EOA receives the purchase funds.

## Protocol references

- [x402 v2 core specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
- [Exact EVM: ERC-7710 transfer method](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md#3-assettransfermethod-erc-7710)
- [Pinned UCP/AP2 interoperability scope](INTEROPERABILITY.md)

References checked 2026-10-14. `yours.purchase` uses the core extension structure `{info,schema}`. Its info binds `version`, `orderHash`, `intentHash` and `executionRef`; the handler's SDK validates those values before submitting a payment.

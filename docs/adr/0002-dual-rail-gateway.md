# ADR 0002: Dual-rail payment gateway (NMI + Stripe)

**Status:** accepted, rolled out dark-first

## Context

Card-on-file billing ran on NMI. We needed Stripe for a subset of customers without risking the existing renewals that were already billing correctly.

## Decision

- Each customer has a `chargeRail` enum (`NMI | STRIPE`) that acts as the system of record. Routing reads only this field. It **never** infers the rail from the shape of a vault id, because ids on one gateway can look like ids on the other.
- `STRIPE_GATEWAY_ENABLED` is a **default-off** flag. While it is off, every routing helper produces exactly the legacy query shape and method (`lib/billing/rail.ts`, with tests asserting the shapes).
- Stripe is reachable only from an **allowlist** of payment contexts (`STRIPE_CHARGEABLE_CONTEXTS`). A new context is excluded until someone adds it on purpose.
- Refunds follow the **original row's** gateway, never the customer's current rail.
  - NMI full refund: void if unsettled, refund if settled.
  - NMI partial refund: refused inside the 24-hour settlement window.
  - Stripe: partial refunds are native and have no window.
- 3DS (`requires_action`) is terminal for an off-session charge. It routes the customer to a card-update flow and is never blindly retried.
- Both rails sit behind one `ChargeGateway` port. The payment core sees four outcomes and nothing gateway-specific.

## Consequences

- We could ship the second rail, its webhook and its reconciliation path to production weeks before the first Stripe charge.
- Reconciliation branches by gateway. Stripe rows resolve by retrieving the PaymentIntent by its stored id, never by search.

# ADR 0004: Mirror-mode migration off the legacy booking vendor

**Status:** accepted (migration completed; mirror jobs since retired)

## Context

About 10K customers, their memberships, visit history and payment history lived in a hosted booking and billing vendor ("LegacyBookingVendor"). Its export quality was uneven, and a hard cutover risked double charges or missed renewals.

## Decision

Run both systems in parallel with a **one-way mirror** (legacy to OS) and cut over **per customer** using a `billingOwner` field (`legacy_vendor | studio_os`).

- All data lands in staging tables first. Feeds are vendor export files (canonical) and an hourly delta feed. A runner then upserts into app tables.
- Guard rails:
  - an advisory lock
  - `--dry-run`
  - a per-entity change limit that aborts the run (`--force` is for the bootstrap only)
  - no-op detection, so unchanged rows are not rewritten
- Anything ambiguous becomes a `MirrorConflict` row keyed by `(entityType, entityId, field)`, with snapshots from both systems, for staff to resolve. Examples are an unmapped plan name or a unique-key collision.
- Once a customer is `billingOwner=studio_os`, the mirror never overwrites them, and only the OS bills them. Daily billing selects only OS-owned customers.
- `MirrorSyncState` tracks the last sync time and last error for each data type.
- Placeholder phone numbers are imported with a flag, never stored as real numbers.

## Consequences

- Cutover was reversible per customer and observable through the conflict queue and sync state.
- Charges imported from the vendor carry no gateway id, so they can't be refunded programmatically. The refund path says so explicitly.
- Details are in `migration/mirror-mode.md`. The skeleton is in `scripts/mirror-sync.skeleton.ts`.

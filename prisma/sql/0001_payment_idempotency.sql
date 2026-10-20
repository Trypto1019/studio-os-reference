-- Partial unique index Prisma cannot express. Apply after `prisma migrate`.
-- A NULL key means "no idempotency requested"; only non-null keys collide.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_idempotencyKey_unique_idx"
  ON "Payment" ("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

-- Reconciliation scans stuck rows oldest-first.
CREATE INDEX IF NOT EXISTS "Payment_recon_pending_idx"
  ON "Payment" ("createdAt")
  WHERE "chargeStatus" = 'PENDING';

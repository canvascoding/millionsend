-- Existing fork deployments already added this column in 0063_lazy_scarecrow.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;

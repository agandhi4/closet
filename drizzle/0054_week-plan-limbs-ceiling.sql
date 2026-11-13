SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #750: the legs-and-feet too-warm bound an auto entry was planned against, so the
-- re-plan can tell "turned too warm" from a near miss chosen knowingly. Nullable, no
-- backfill: the stored limbs cannot show it, and null entries are never judged on it.
ALTER TABLE "week_plan_entry" ADD COLUMN "limbs_ceiling" smallint;--> statement-breakpoint
ALTER TABLE "week_plan_entry" ADD CONSTRAINT "week_plan_entry_limbs_ceiling_check" CHECK ("week_plan_entry"."limbs_ceiling" between 1 and 5);

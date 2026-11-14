SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #748: whether the pick that planned an entry also created its outfit.
-- Existing entries stay null, "not known to be", so their removal keeps
-- the outfit as it always did.
ALTER TABLE "outfit_calendar" ADD COLUMN "outfit_created" boolean;

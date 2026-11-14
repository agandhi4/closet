SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #676: the instant of a wash and of a wear, so a same-day wear after the wash
-- counts toward the next one. Nullable, no data step: null is the day rule,
-- which is what every existing row has meant.
ALTER TABLE "garment" ADD COLUMN "washed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "garment_wear" ADD COLUMN "worn_at" timestamp with time zone;

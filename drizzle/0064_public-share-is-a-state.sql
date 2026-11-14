-- A public share link is a state (#669): null until Share is tapped, null again
-- after Stop sharing. Existing ids are kept, so links already sent keep working
-- until their owner stops them (docs/decisions.md 2026-11-14). The unique indexes
-- stay: a btree unique index admits any number of NULLs.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "garment" ALTER COLUMN "shareable_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outfit" ALTER COLUMN "shareable_id" DROP NOT NULL;

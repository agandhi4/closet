SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #652: which history of this database the changes feed's cursors belong
-- to. Its one row is written here, with a random epoch and no bump: cursors
-- answered before this deploy carry no epoch and stay current until the
-- first bump (a restore), when every device re-syncs in full.
CREATE TABLE "sync_epoch" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"epoch" uuid DEFAULT gen_random_uuid() NOT NULL,
	"bumped_at" timestamp with time zone,
	CONSTRAINT "sync_epoch_singleton_check" CHECK ("sync_epoch"."singleton")
);
--> statement-breakpoint
INSERT INTO "sync_epoch" DEFAULT VALUES;

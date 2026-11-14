SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #833: which photo storage this database belongs to, in one row. Nothing
-- is backfilled here: the first claim after the deploy writes it from the
-- share's existing .closet-storage marker (claimStorage).
CREATE TABLE "install" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"install_id" uuid NOT NULL,
	"paired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_singleton_check" CHECK ("install"."singleton")
);

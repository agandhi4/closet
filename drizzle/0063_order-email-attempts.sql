-- Every ALTER TABLE below takes order_email's ACCESS EXCLUSIVE lock until the boot's
-- migration transaction commits; behind a long reader it gives up after 5 s and the
-- boot fails and is retried (as 0051). Existing rows are decided (the defaults): no backfill.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "order_email" ALTER COLUMN "outcome" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_email" ADD COLUMN "status" text DEFAULT 'decided' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_email" ADD COLUMN "attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_email" ADD COLUMN "mailbox_failures" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_email" ADD COLUMN "error_kind" text;--> statement-breakpoint
ALTER TABLE "order_email" ADD CONSTRAINT "order_email_status_check" CHECK ("order_email"."status" in ('decided', 'failed', 'parked'));--> statement-breakpoint
ALTER TABLE "order_email" ADD CONSTRAINT "order_email_decided_check" CHECK (("order_email"."status" = 'decided') = ("order_email"."outcome" is not null) and ("order_email"."status" = 'decided') = ("order_email"."error_kind" is null));--> statement-breakpoint
ALTER TABLE "order_email" ADD CONSTRAINT "order_email_attempts_check" CHECK ("order_email"."attempts" >= 0 and "order_email"."mailbox_failures" >= 0);
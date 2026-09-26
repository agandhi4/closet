-- Web Push subscriptions (src/web/push/): the keys become columns, the
-- endpoint and user agent text (Firefox endpoints run past 255 characters),
-- and rows gain created_at/updated_at. See docs/audits/2026-09-25-program2,
-- datamodel 1.4 and 1.7.
-- Written by hand in drizzle-kit's form: generate cannot tell the dropped
-- web_push_subscription from the added key columns without a TTY prompt.
-- The snapshot is drizzle-kit's own (generateDrizzleJson from
-- src/db/schema.ts), and a second `drizzle-kit generate` finds nothing to do.
-- Self-contained: touches only user_device.
ALTER TABLE "user_device" ALTER COLUMN "push_endpoint" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_device" ALTER COLUMN "user_agent" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_device" ALTER COLUMN "user_agent" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "key_p256dh" text;--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "key_auth" text;--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-written: the keys out of the stored subscription JSON. A row without
-- both as strings cannot be pushed to (and no build ever managed to write
-- one, see audit A1): it is deleted rather than kept broken. Nothing a user
-- wrote is lost; the browser sends its subscription again on its next
-- signed-in start (public/js/push.js).
UPDATE "user_device" SET
  "key_p256dh" = CASE
    WHEN jsonb_typeof("web_push_subscription" #> '{keys,p256dh}') = 'string'
    THEN "web_push_subscription" #>> '{keys,p256dh}' END,
  "key_auth" = CASE
    WHEN jsonb_typeof("web_push_subscription" #> '{keys,auth}') = 'string'
    THEN "web_push_subscription" #>> '{keys,auth}' END;--> statement-breakpoint
DELETE FROM "user_device" WHERE "key_p256dh" IS NULL OR "key_auth" IS NULL;--> statement-breakpoint
ALTER TABLE "user_device" ALTER COLUMN "key_p256dh" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_device" ALTER COLUMN "key_auth" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_device" DROP COLUMN "web_push_subscription";

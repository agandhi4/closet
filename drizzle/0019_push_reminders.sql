CREATE TABLE "push_reminder" (
	"device_id" integer NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_reminder_pkey" PRIMARY KEY("device_id","kind","day"),
	CONSTRAINT "push_reminder_kind_check" CHECK ("push_reminder"."kind" in ('morning', 'evening'))
);
--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "morning_reminder" smallint;--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "evening_reminder" smallint;--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "reminders_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_reminder" ADD CONSTRAINT "push_reminder_device_id_foreign" FOREIGN KEY ("device_id") REFERENCES "public"."user_device"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_morning_reminder_check" CHECK ("user_device"."morning_reminder" between 300 and 660 and "user_device"."morning_reminder" % 15 = 0);--> statement-breakpoint
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_evening_reminder_check" CHECK ("user_device"."evening_reminder" between 1020 and 1380 and "user_device"."evening_reminder" % 15 = 0);--> statement-breakpoint
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_reminders_set_at_check" CHECK (("user_device"."morning_reminder" is null and "user_device"."evening_reminder" is null) or "user_device"."reminders_set_at" is not null);
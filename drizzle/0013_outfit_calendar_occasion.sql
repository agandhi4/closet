-- #13: the part of the day an entry is for. Every existing entry becomes
-- all day through the column's default.
ALTER TABLE "outfit_calendar" ADD COLUMN "occasion" text DEFAULT 'all-day' NOT NULL;--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_occasion_check" CHECK ("outfit_calendar"."occasion" in ('all-day', 'workout', 'work', 'daytime', 'evening', 'night-out'));
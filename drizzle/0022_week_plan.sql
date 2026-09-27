CREATE TABLE "week_plan" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "week_plan_entry" (
	"entry_id" integer PRIMARY KEY NOT NULL,
	"week_plan_id" integer NOT NULL,
	"outfit_created" boolean NOT NULL,
	"torso" smallint,
	"limbs" smallint,
	"layer" boolean,
	"rain" boolean,
	CONSTRAINT "week_plan_entry_needs_check" CHECK (num_nulls("week_plan_entry"."torso", "week_plan_entry"."limbs", "week_plan_entry"."layer", "week_plan_entry"."rain") in (0, 4))
);
--> statement-breakpoint
CREATE TABLE "week_replan" (
	"user_id" integer NOT NULL,
	"day" date NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "week_replan_pkey" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
CREATE TABLE "week_template" (
	"user_id" integer NOT NULL,
	"weekday" smallint NOT NULL,
	"occasion" text NOT NULL,
	CONSTRAINT "week_template_pkey" PRIMARY KEY("user_id","weekday","occasion"),
	CONSTRAINT "week_template_weekday_check" CHECK ("week_template"."weekday" between 0 and 6),
	CONSTRAINT "week_template_occasion_check" CHECK ("week_template"."occasion" in ('all-day', 'workout', 'work', 'daytime', 'evening', 'night-out'))
);
--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD COLUMN "planned_by" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "week_plan" ADD CONSTRAINT "week_plan_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "week_plan_entry" ADD CONSTRAINT "week_plan_entry_entry_id_foreign" FOREIGN KEY ("entry_id") REFERENCES "public"."outfit_calendar"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "week_plan_entry" ADD CONSTRAINT "week_plan_entry_week_plan_id_foreign" FOREIGN KEY ("week_plan_id") REFERENCES "public"."week_plan"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "week_replan" ADD CONSTRAINT "week_replan_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "week_template" ADD CONSTRAINT "week_template_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "week_plan_owner_id_index" ON "week_plan" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "week_plan_entry_week_plan_id_index" ON "week_plan_entry" USING btree ("week_plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "week_template_user_id_weekday_day_unique" ON "week_template" USING btree ("user_id","weekday") WHERE "week_template"."occasion" in ('all-day', 'work', 'daytime');--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_planned_by_check" CHECK ("outfit_calendar"."planned_by" in ('user', 'auto'));--> statement-breakpoint
-- #34a's style_rhythm counted occasions ("work 3 a week"); the week template
-- (#16) says which weekdays hold them and is now the one model of the
-- week, the rhythm derived from it. Weekly counts are spread onto weekdays,
-- one day occasion (work, daytime, all-day, in that order) per weekday:
-- work from Monday on, daytime and all-day from the weekend back, and a
-- workout, evening or night out spread across the week (Monday, Thursday,
-- Saturday, ...). Monthly counts ("evening 3 a month") have no weekday and
-- are not carried over. Only the seed's demo persona held any rows; the
-- editor on the profile changes the days.
DO $$
DECLARE
  rhythm record;
BEGIN
  FOR rhythm IN
    SELECT "user_id", "occasion", least("times", 7) AS "times"
    FROM "style_rhythm"
    WHERE "per" = 'week'
    ORDER BY "user_id", array_position(ARRAY['work', 'daytime', 'all-day', 'workout', 'evening', 'night-out'], "occasion")
  LOOP
    INSERT INTO "week_template" ("user_id", "weekday", "occasion")
    SELECT rhythm."user_id", d."weekday", rhythm."occasion"
    FROM unnest(CASE rhythm."occasion"
        WHEN 'work' THEN ARRAY[1, 2, 3, 4, 5, 6, 0]
        WHEN 'daytime' THEN ARRAY[6, 0, 5, 4, 3, 2, 1]
        WHEN 'all-day' THEN ARRAY[6, 0, 5, 4, 3, 2, 1]
        ELSE ARRAY[1, 4, 6, 2, 5, 0, 3]
      END) WITH ORDINALITY AS d("weekday", "position")
    WHERE rhythm."occasion" NOT IN ('all-day', 'work', 'daytime')
      OR NOT EXISTS (
        SELECT 1 FROM "week_template" "taken"
        WHERE "taken"."user_id" = rhythm."user_id"
          AND "taken"."weekday" = d."weekday"
          AND "taken"."occasion" IN ('all-day', 'work', 'daytime'))
    ORDER BY d."position"
    LIMIT rhythm."times";
  END LOOP;
END $$;--> statement-breakpoint
DROP TABLE "style_rhythm";

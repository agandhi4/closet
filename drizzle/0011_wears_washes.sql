CREATE TABLE "garment_wear" (
	"id" serial PRIMARY KEY NOT NULL,
	"garment_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"day" date NOT NULL,
	"outfit_calendar_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "garment_wear_outfit_calendar_id_garment_id_unique" UNIQUE("outfit_calendar_id","garment_id")
);
--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "quantity" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "wash_after_wears" smallint;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "last_washed_on" date;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "away" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "away_note" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "condition" text DEFAULT 'good' NOT NULL;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "condition_note" text;--> statement-breakpoint
ALTER TABLE "garment_wear" ADD CONSTRAINT "garment_wear_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "garment_wear" ADD CONSTRAINT "garment_wear_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "garment_wear" ADD CONSTRAINT "garment_wear_outfit_calendar_id_foreign" FOREIGN KEY ("outfit_calendar_id") REFERENCES "public"."outfit_calendar"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "garment_wear_garment_id_day_single_unique" ON "garment_wear" USING btree ("garment_id","day") WHERE "garment_wear"."outfit_calendar_id" is null;--> statement-breakpoint
CREATE INDEX "garment_wear_garment_id_day_index" ON "garment_wear" USING btree ("garment_id","day");--> statement-breakpoint
CREATE INDEX "garment_wear_owner_id_index" ON "garment_wear" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_quantity_check" CHECK ("garment"."quantity" between 1 and 30);--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_wash_after_wears_check" CHECK ("garment"."wash_after_wears" between 0 and 20);--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_away_check" CHECK ("garment"."away" in ('lent', 'repair'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_away_note_check" CHECK ("garment"."away_note" is null or "garment"."away" is not null);--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_condition_check" CHECK ("garment"."condition" in ('good', 'needs_repair', 'replace_soon'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_condition_note_check" CHECK ("garment"."condition_note" is null or "garment"."condition" <> 'good');--> statement-breakpoint
-- Backfill (hand-added): calendar entries marked worn before the wear log
-- existed get their wear rows, as setEntryWorn would have written them. The
-- outfit's slots as they are now are the only record of what was worn, so
-- they are the snapshot; only garments of the entry's owner, each once per
-- entry, dated the entry's day, created when it was marked worn.
INSERT INTO "garment_wear" ("garment_id", "owner_id", "day", "outfit_calendar_id", "created_at")
SELECT DISTINCT "outfit_slot"."garment_id", "outfit_calendar"."owner_id", "outfit_calendar"."day", "outfit_calendar"."id", "outfit_calendar"."worn_at"
FROM "outfit_calendar"
JOIN "outfit_slot" ON "outfit_slot"."outfit_id" = "outfit_calendar"."outfit_id"
JOIN "garment" ON "garment"."id" = "outfit_slot"."garment_id" AND "garment"."owner_id" = "outfit_calendar"."owner_id"
WHERE "outfit_calendar"."worn_at" IS NOT NULL;

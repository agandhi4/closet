CREATE TABLE "garment_repair" (
	"id" serial PRIMARY KEY NOT NULL,
	"garment_id" integer NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"note" text NOT NULL,
	"cost" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "garment_repair_kind_check" CHECK ("garment_repair"."kind" in ('repair', 'alteration')),
	CONSTRAINT "garment_repair_cost_check" CHECK ("garment_repair"."cost" >= 0),
	CONSTRAINT "garment_repair_note_check" CHECK (length(trim("garment_repair"."note")) > 0)
);
--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "care_wash" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "care_bleach" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "care_dry" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "care_iron" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "care_dry_clean" text;--> statement-breakpoint
ALTER TABLE "garment_repair" ADD CONSTRAINT "garment_repair_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "garment_repair_garment_id_day_index" ON "garment_repair" USING btree ("garment_id","day");--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_care_wash_check" CHECK ("garment"."care_wash" in ('hot', 'warm', 'cold', 'hand', 'do_not_wash'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_care_bleach_check" CHECK ("garment"."care_bleach" in ('any', 'non_chlorine', 'do_not_bleach'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_care_dry_check" CHECK ("garment"."care_dry" in ('tumble', 'tumble_low', 'do_not_tumble', 'line', 'flat'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_care_iron_check" CHECK ("garment"."care_iron" in ('high', 'medium', 'low', 'do_not_iron'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_care_dry_clean_check" CHECK ("garment"."care_dry_clean" in ('allowed', 'only', 'never'));
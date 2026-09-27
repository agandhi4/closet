CREATE TABLE "selfie" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"day" date NOT NULL,
	"outfit_calendar_id" integer,
	"photo_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "selfie_outfit_calendar_id_unique" UNIQUE("outfit_calendar_id"),
	CONSTRAINT "selfie_photo_id_unique" UNIQUE("photo_id")
);
--> statement-breakpoint
ALTER TABLE "file" DROP CONSTRAINT "file_cutout_status_check";--> statement-breakpoint
ALTER TABLE "selfie" ADD CONSTRAINT "selfie_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "selfie" ADD CONSTRAINT "selfie_outfit_calendar_id_foreign" FOREIGN KEY ("outfit_calendar_id") REFERENCES "public"."outfit_calendar"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "selfie" ADD CONSTRAINT "selfie_photo_id_foreign" FOREIGN KEY ("photo_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "selfie_owner_id_day_index" ON "selfie" USING btree ("owner_id","day");--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_cutout_status_check" CHECK ("file"."cutout_status" in ('none', 'pending', 'ready', 'failed', 'edited', 'unwanted'));
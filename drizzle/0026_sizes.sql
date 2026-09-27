CREATE TABLE "body_measurements" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"unit" text DEFAULT 'in' NOT NULL,
	"height_cm" numeric(5, 2),
	"neck_cm" numeric(5, 2),
	"shoulders_cm" numeric(5, 2),
	"chest_cm" numeric(5, 2),
	"sleeve_cm" numeric(5, 2),
	"waist_cm" numeric(5, 2),
	"hips_cm" numeric(5, 2),
	"inseam_cm" numeric(5, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "body_measurements_unit_check" CHECK ("body_measurements"."unit" in ('in', 'cm')),
	CONSTRAINT "body_measurements_length_check" CHECK ("body_measurements"."height_cm" between 1 and 300 and "body_measurements"."neck_cm" between 1 and 300 and "body_measurements"."shoulders_cm" between 1 and 300 and "body_measurements"."chest_cm" between 1 and 300 and "body_measurements"."sleeve_cm" between 1 and 300 and "body_measurements"."waist_cm" between 1 and 300 and "body_measurements"."hips_cm" between 1 and 300 and "body_measurements"."inseam_cm" between 1 and 300)
);
--> statement-breakpoint
CREATE TABLE "brand_size" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"brand" text NOT NULL,
	"brand_key" text NOT NULL,
	"size" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_size_size_or_note_check" CHECK ("brand_size"."size" is not null or "brand_size"."note" is not null)
);
--> statement-breakpoint
ALTER TABLE "body_measurements" ADD CONSTRAINT "body_measurements_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "brand_size" ADD CONSTRAINT "brand_size_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_size_user_id_brand_key_unique" ON "brand_size" USING btree ("user_id","brand_key");
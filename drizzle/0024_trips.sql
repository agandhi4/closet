CREATE TABLE "trip" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"destination" text,
	"latitude" numeric(4, 2),
	"longitude" numeric(5, 2),
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_dates_check" CHECK ("trip"."ends_on" >= "trip"."starts_on"),
	CONSTRAINT "trip_location_check" CHECK (("trip"."latitude" is null) = ("trip"."longitude" is null) and ("trip"."latitude" is null or "trip"."destination" is not null)),
	CONSTRAINT "trip_coordinates_check" CHECK ("trip"."latitude" between -90 and 90 and "trip"."longitude" between -180 and 180)
);
--> statement-breakpoint
CREATE TABLE "trip_garment_packed" (
	"trip_id" integer NOT NULL,
	"garment_id" integer NOT NULL,
	CONSTRAINT "trip_garment_packed_pkey" PRIMARY KEY("trip_id","garment_id")
);
--> statement-breakpoint
CREATE TABLE "trip_item" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"label" text NOT NULL,
	"packed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_outfit" (
	"id" serial PRIMARY KEY NOT NULL,
	"trip_id" integer NOT NULL,
	"outfit_id" integer NOT NULL,
	"day" date,
	"occasion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trip_outfit_occasion_check" CHECK ("trip_outfit"."occasion" in ('all-day', 'workout', 'work', 'daytime', 'evening', 'night-out'))
);
--> statement-breakpoint
ALTER TABLE "trip" ADD CONSTRAINT "trip_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trip_garment_packed" ADD CONSTRAINT "trip_garment_packed_trip_id_foreign" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trip_garment_packed" ADD CONSTRAINT "trip_garment_packed_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trip_item" ADD CONSTRAINT "trip_item_trip_id_foreign" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trip_outfit" ADD CONSTRAINT "trip_outfit_trip_id_foreign" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trip_outfit" ADD CONSTRAINT "trip_outfit_outfit_id_foreign" FOREIGN KEY ("outfit_id") REFERENCES "public"."outfit"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "trip_owner_id_starts_on_index" ON "trip" USING btree ("owner_id","starts_on");--> statement-breakpoint
CREATE INDEX "trip_garment_packed_garment_id_index" ON "trip_garment_packed" USING btree ("garment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_item_trip_id_lower_label_unique" ON "trip_item" USING btree ("trip_id",lower("label"));--> statement-breakpoint
CREATE UNIQUE INDEX "trip_outfit_trip_id_outfit_id_day_unique" ON "trip_outfit" USING btree ("trip_id","outfit_id","day") WHERE "trip_outfit"."day" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "trip_outfit_trip_id_outfit_id_undated_unique" ON "trip_outfit" USING btree ("trip_id","outfit_id") WHERE "trip_outfit"."day" is null;--> statement-breakpoint
CREATE INDEX "trip_outfit_outfit_id_index" ON "trip_outfit" USING btree ("outfit_id");
CREATE TABLE "file" (
	"id" serial PRIMARY KEY NOT NULL,
	"shareable_id" varchar(255) NOT NULL,
	"flagged" boolean,
	"banned" boolean,
	"file_name" varchar(255) NOT NULL,
	"mimetype" varchar(255),
	"created_on" varchar(255) NOT NULL,
	"created_by_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "file_file_name_unique" UNIQUE("file_name")
);
--> statement-breakpoint
CREATE TABLE "garment" (
	"id" serial PRIMARY KEY NOT NULL,
	"shareable_id" varchar(255) NOT NULL,
	"flagged" boolean,
	"banned" boolean,
	"name" varchar(255),
	"category" varchar(255) NOT NULL,
	"brand" varchar(255),
	"size" varchar(255),
	"notes" varchar(255),
	"photo_id" integer,
	"owner_id" integer NOT NULL,
	"color" varchar(255),
	"date_aquired" timestamp with time zone,
	"washing_details" text,
	"archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "garment_photo_id_unique" UNIQUE("photo_id")
);
--> statement-breakpoint
CREATE TABLE "outfit" (
	"id" serial PRIMARY KEY NOT NULL,
	"shareable_id" varchar(255) NOT NULL,
	"flagged" boolean,
	"banned" boolean,
	"name" varchar(255),
	"notes" varchar(255),
	"owner_id" integer NOT NULL,
	"slots" jsonb
);
--> statement-breakpoint
CREATE TABLE "outfit_calendar" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"outfit_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"worn_at" timestamp with time zone,
	"notes" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "outfit_garments" (
	"outfit_id" integer NOT NULL,
	"garment_id" integer NOT NULL,
	CONSTRAINT "outfit_garments_pkey" PRIMARY KEY("outfit_id","garment_id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" serial PRIMARY KEY NOT NULL,
	"shareable_id" varchar(255) NOT NULL,
	"flagged" boolean,
	"banned" boolean,
	"first_name" varchar(255),
	"last_name" varchar(255),
	"email" varchar(255),
	"password" varchar(255) NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_device" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_agent" varchar(255) NOT NULL,
	"push_endpoint" varchar(255) NOT NULL,
	"web_push_subscription" jsonb,
	"user_id" integer NOT NULL,
	CONSTRAINT "user_device_push_endpoint_unique" UNIQUE("push_endpoint")
);
--> statement-breakpoint
CREATE TABLE "wardrobe_share" (
	"id" serial PRIMARY KEY NOT NULL,
	"grantor_id" integer NOT NULL,
	"grantee_id" integer,
	"permission" varchar(255) DEFAULT 'VIEW' NOT NULL,
	"invite_token" varchar(255),
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wardrobe_share_invite_token_unique" UNIQUE("invite_token"),
	CONSTRAINT "wardrobe_share_grantor_id_grantee_id_unique" UNIQUE("grantor_id","grantee_id")
);
--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_created_by_id_foreign" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_photo_id_foreign" FOREIGN KEY ("photo_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_outfit_id_foreign" FOREIGN KEY ("outfit_id") REFERENCES "public"."outfit"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit_garments" ADD CONSTRAINT "outfit_garments_outfit_id_foreign" FOREIGN KEY ("outfit_id") REFERENCES "public"."outfit"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit_garments" ADD CONSTRAINT "outfit_garments_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "wardrobe_share" ADD CONSTRAINT "wardrobe_share_grantor_id_foreign" FOREIGN KEY ("grantor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "wardrobe_share" ADD CONSTRAINT "wardrobe_share_grantee_id_foreign" FOREIGN KEY ("grantee_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "file_created_by_id_index" ON "file" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "file_shareable_id_index" ON "file" USING btree ("shareable_id");--> statement-breakpoint
CREATE INDEX "garment_category_index" ON "garment" USING btree ("category");--> statement-breakpoint
CREATE INDEX "garment_owner_id_index" ON "garment" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "garment_shareable_id_index" ON "garment" USING btree ("shareable_id");--> statement-breakpoint
CREATE INDEX "outfit_owner_id_index" ON "outfit" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "outfit_shareable_id_index" ON "outfit" USING btree ("shareable_id");--> statement-breakpoint
CREATE INDEX "outfit_calendar_date_index" ON "outfit_calendar" USING btree ("date");--> statement-breakpoint
CREATE INDEX "outfit_calendar_outfit_id_index" ON "outfit_calendar" USING btree ("outfit_id");--> statement-breakpoint
CREATE INDEX "outfit_calendar_owner_id_index" ON "outfit_calendar" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "outfit_garments_garment_id_index" ON "outfit_garments" USING btree ("garment_id");--> statement-breakpoint
CREATE INDEX "outfit_garments_outfit_id_index" ON "outfit_garments" USING btree ("outfit_id");--> statement-breakpoint
CREATE INDEX "user_shareable_id_index" ON "user" USING btree ("shareable_id");--> statement-breakpoint
CREATE INDEX "user_device_user_id_index" ON "user_device" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wardrobe_share_grantee_id_index" ON "wardrobe_share" USING btree ("grantee_id");--> statement-breakpoint
CREATE INDEX "wardrobe_share_grantor_id_index" ON "wardrobe_share" USING btree ("grantor_id");
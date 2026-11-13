-- Expand-only (#196a-2): the sync columns. Every ADD COLUMN default is a
-- constant or now(), so no table is rewritten (existing rows read revision
-- 0 and updated_at = this migration's instant). Each ALTER takes its
-- table's ACCESS EXCLUSIVE lock until the boot's migration transaction
-- commits: behind a long writer of the previous build it gives up after 5 s
-- and the boot fails and is retried (the container restart), rather than
-- queueing every request behind the DDL. SET LOCAL: the transaction's only.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "sync_tombstone" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"resource" text NOT NULL,
	"resource_id" integer NOT NULL,
	"client_id" uuid,
	"revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_tombstone_resource_check" CHECK ("sync_tombstone"."resource" in ('garment', 'outfit', 'outfit_calendar', 'garment_wear', 'selfie', 'capsule', 'trip', 'week_plan', 'brand_size', 'style_profile', 'body_measurements'))
);
--> statement-breakpoint
ALTER TABLE "body_measurements" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_size" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_size" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_size" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "capsule" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "capsule" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "capsule" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "garment_wear" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "garment_wear" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "garment_wear" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "selfie" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "selfie" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "style_profile" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trip" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trip" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "trip" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "trip_item" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "sync_floor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "week_template_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "week_plan" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "week_plan" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_tombstone" ADD CONSTRAINT "sync_tombstone_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "sync_tombstone_owner_id_revision_index" ON "sync_tombstone" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "sync_tombstone_owner_id_client_id_index" ON "sync_tombstone" USING btree ("owner_id","client_id") WHERE "sync_tombstone"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "brand_size_user_id_revision_index" ON "brand_size" USING btree ("user_id","revision");--> statement-breakpoint
CREATE INDEX "capsule_owner_id_revision_index" ON "capsule" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "garment_owner_id_revision_index" ON "garment" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "garment_wear_owner_id_revision_index" ON "garment_wear" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "outfit_owner_id_revision_index" ON "outfit" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "outfit_calendar_owner_id_revision_index" ON "outfit_calendar" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "selfie_owner_id_revision_index" ON "selfie" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "trip_owner_id_revision_index" ON "trip" USING btree ("owner_id","revision");--> statement-breakpoint
CREATE INDEX "week_plan_owner_id_revision_index" ON "week_plan" USING btree ("owner_id","revision");--> statement-breakpoint
ALTER TABLE "brand_size" ADD CONSTRAINT "brand_size_user_id_client_id_unique" UNIQUE("user_id","client_id");--> statement-breakpoint
ALTER TABLE "capsule" ADD CONSTRAINT "capsule_owner_id_client_id_unique" UNIQUE("owner_id","client_id");--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_owner_id_client_id_unique" UNIQUE("owner_id","client_id");--> statement-breakpoint
ALTER TABLE "garment_wear" ADD CONSTRAINT "garment_wear_owner_id_client_id_unique" UNIQUE("owner_id","client_id");--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_owner_id_client_id_unique" UNIQUE("owner_id","client_id");--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_owner_id_client_id_unique" UNIQUE("owner_id","client_id");--> statement-breakpoint
ALTER TABLE "trip" ADD CONSTRAINT "trip_owner_id_client_id_unique" UNIQUE("owner_id","client_id");--> statement-breakpoint
ALTER TABLE "trip_item" ADD CONSTRAINT "trip_item_trip_id_client_id_unique" UNIQUE("trip_id","client_id");
ALTER TABLE "pending_photo" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_photo" ADD COLUMN "batch_position" smallint;--> statement-breakpoint
ALTER TABLE "pending_photo" ADD COLUMN "batch_owner_id" integer;--> statement-breakpoint
ALTER TABLE "pending_photo" ADD CONSTRAINT "pending_photo_batch_owner_id_foreign" FOREIGN KEY ("batch_owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "pending_photo_batch_owner_id_index" ON "pending_photo" USING btree ("batch_owner_id");--> statement-breakpoint
ALTER TABLE "pending_photo" ADD CONSTRAINT "pending_photo_batch_check" CHECK (("pending_photo"."batch_id" is null) = ("pending_photo"."batch_position" is null));
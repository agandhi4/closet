ALTER TABLE "plan_look" ADD COLUMN "outfit_id" integer;--> statement-breakpoint
ALTER TABLE "plan_look" ADD CONSTRAINT "plan_look_outfit_id_foreign" FOREIGN KEY ("outfit_id") REFERENCES "public"."outfit"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "plan_look_outfit_id_index" ON "plan_look" USING btree ("outfit_id");
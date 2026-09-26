CREATE TABLE "pending_photo" (
	"file_name" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_photo" ADD CONSTRAINT "pending_photo_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "pending_photo_user_id_created_at_index" ON "pending_photo" USING btree ("user_id","created_at");
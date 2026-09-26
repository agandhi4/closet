CREATE TABLE "capsule" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capsule_garment" (
	"capsule_id" integer NOT NULL,
	"garment_id" integer NOT NULL,
	CONSTRAINT "capsule_garment_pkey" PRIMARY KEY("capsule_id","garment_id")
);
--> statement-breakpoint
ALTER TABLE "capsule" ADD CONSTRAINT "capsule_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "capsule_garment" ADD CONSTRAINT "capsule_garment_capsule_id_foreign" FOREIGN KEY ("capsule_id") REFERENCES "public"."capsule"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "capsule_garment" ADD CONSTRAINT "capsule_garment_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "capsule_owner_id_lower_name_unique" ON "capsule" USING btree ("owner_id",lower("name"));--> statement-breakpoint
CREATE INDEX "capsule_garment_garment_id_index" ON "capsule_garment" USING btree ("garment_id");
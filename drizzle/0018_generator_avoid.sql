CREATE TABLE "generator_avoid" (
	"owner_id" integer NOT NULL,
	"garment_a_id" integer NOT NULL,
	"garment_b_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generator_avoid_pkey" PRIMARY KEY("owner_id","garment_a_id","garment_b_id"),
	CONSTRAINT "generator_avoid_pair_order_check" CHECK ("generator_avoid"."garment_a_id" < "generator_avoid"."garment_b_id")
);
--> statement-breakpoint
ALTER TABLE "generator_avoid" ADD CONSTRAINT "generator_avoid_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "generator_avoid" ADD CONSTRAINT "generator_avoid_garment_a_id_foreign" FOREIGN KEY ("garment_a_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "generator_avoid" ADD CONSTRAINT "generator_avoid_garment_b_id_foreign" FOREIGN KEY ("garment_b_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "generator_avoid_garment_a_id_index" ON "generator_avoid" USING btree ("garment_a_id");--> statement-breakpoint
CREATE INDEX "generator_avoid_garment_b_id_index" ON "generator_avoid" USING btree ("garment_b_id");
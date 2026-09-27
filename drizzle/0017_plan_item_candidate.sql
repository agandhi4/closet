CREATE TABLE "plan_item_candidate" (
	"plan_item_id" integer NOT NULL,
	"garment_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_item_candidate_pkey" PRIMARY KEY("plan_item_id","garment_id")
);
--> statement-breakpoint
ALTER TABLE "plan_item_candidate" ADD CONSTRAINT "plan_item_candidate_plan_item_id_foreign" FOREIGN KEY ("plan_item_id") REFERENCES "public"."plan_item"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "plan_item_candidate" ADD CONSTRAINT "plan_item_candidate_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "plan_item_candidate_garment_id_index" ON "plan_item_candidate" USING btree ("garment_id");
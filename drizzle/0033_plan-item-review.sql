CREATE TABLE "plan_item_rejection" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_item_id" integer NOT NULL,
	"name" text,
	"brand" text,
	"url" text,
	"price" numeric(10, 2),
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_item" ADD COLUMN "review" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_item" ADD COLUMN "owner_note" text;--> statement-breakpoint
ALTER TABLE "plan_item" ADD COLUMN "changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Backfill (hand-added): the agent's unaccepted items stay proposed, the rest
-- were accepted; 0034 then drops the boolean. Changed at creation, as far as
-- anyone knows.
UPDATE "plan_item" SET "review" = 'proposed' WHERE "proposed";--> statement-breakpoint
UPDATE "plan_item" SET "changed_at" = "created_at";--> statement-breakpoint
ALTER TABLE "plan_item_rejection" ADD CONSTRAINT "plan_item_rejection_plan_item_id_foreign" FOREIGN KEY ("plan_item_id") REFERENCES "public"."plan_item"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "plan_item_rejection_plan_item_id_index" ON "plan_item_rejection" USING btree ("plan_item_id");--> statement-breakpoint
ALTER TABLE "plan_item" ADD CONSTRAINT "plan_item_review_check" CHECK ("plan_item"."review" in ('proposed', 'accepted', 'revise', 'declined'));--> statement-breakpoint
ALTER TABLE "plan_item" ADD CONSTRAINT "plan_item_owner_note_check" CHECK ("plan_item"."review" <> 'revise' or "plan_item"."owner_note" is not null);
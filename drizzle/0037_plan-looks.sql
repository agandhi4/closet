CREATE TABLE "plan_look" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"name" text NOT NULL,
	"occasion" text,
	"note" text,
	"reaction" text DEFAULT 'proposed' NOT NULL,
	"owner_note" text,
	"agent_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_look_reaction_check" CHECK ("plan_look"."reaction" in ('proposed', 'loved', 'revise', 'declined')),
	CONSTRAINT "plan_look_owner_note_check" CHECK ("plan_look"."reaction" <> 'revise' or "plan_look"."owner_note" is not null),
	CONSTRAINT "plan_look_occasion_check" CHECK ("plan_look"."occasion" in ('all-day', 'workout', 'work', 'daytime', 'evening', 'night-out'))
);
--> statement-breakpoint
CREATE TABLE "plan_look_slot" (
	"look_id" integer NOT NULL,
	"position" smallint NOT NULL,
	"category" text NOT NULL,
	"garment_id" integer,
	CONSTRAINT "plan_look_slot_pkey" PRIMARY KEY("look_id","position"),
	CONSTRAINT "plan_look_slot_look_id_garment_id_unique" UNIQUE("look_id","garment_id")
);
--> statement-breakpoint
ALTER TABLE "plan_look" ADD CONSTRAINT "plan_look_plan_id_foreign" FOREIGN KEY ("plan_id") REFERENCES "public"."wardrobe_plan"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "plan_look_slot" ADD CONSTRAINT "plan_look_slot_look_id_foreign" FOREIGN KEY ("look_id") REFERENCES "public"."plan_look"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "plan_look_slot" ADD CONSTRAINT "plan_look_slot_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "plan_look_plan_id_index" ON "plan_look" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "plan_look_slot_garment_id_index" ON "plan_look_slot" USING btree ("garment_id");
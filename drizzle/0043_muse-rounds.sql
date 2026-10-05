CREATE TABLE "muse_round" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"token_id" integer,
	"since" timestamp with time zone,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" text,
	CONSTRAINT "muse_round_summary_check" CHECK ("muse_round"."summary" is null or length(trim("muse_round"."summary")) > 0)
);
--> statement-breakpoint
ALTER TABLE "user_device" ADD COLUMN "muse_rounds" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "muse_round" ADD CONSTRAINT "muse_round_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "muse_round" ADD CONSTRAINT "muse_round_token_id_foreign" FOREIGN KEY ("token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "muse_round_owner_id_finished_at_index" ON "muse_round" USING btree ("owner_id","finished_at");--> statement-breakpoint
CREATE INDEX "muse_round_token_id_index" ON "muse_round" USING btree ("token_id");
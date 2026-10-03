ALTER TABLE "plan_item_candidate" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "plan_item_candidate" ADD COLUMN "rank" smallint;--> statement-breakpoint
ALTER TABLE "plan_item_candidate" ADD CONSTRAINT "plan_item_candidate_note_check" CHECK ("plan_item_candidate"."note" is null or length(trim("plan_item_candidate"."note")) > 0);--> statement-breakpoint
ALTER TABLE "plan_item_candidate" ADD CONSTRAINT "plan_item_candidate_rank_check" CHECK ("plan_item_candidate"."rank" between 1 and 5);
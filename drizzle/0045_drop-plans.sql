-- Wardrobe plans go (#337 part B2, after B1 removed their code). Their rows
-- are dropped, not migrated (decision D10: 0040 moved the candidates and
-- rejections, 0041 the looks); a pg_dump of the six tables, taken before
-- the deploy, is the rollback. Hand-ordered from drizzle-kit's output: the
-- two link columns' foreign keys and constraints, the columns, then the
-- tables, each before the table it references. No CASCADE, so anything
-- else still depending on a plan table fails the boot instead of going
-- with it.
ALTER TABLE "option_group" DROP CONSTRAINT "option_group_plan_item_id_foreign";--> statement-breakpoint
ALTER TABLE "outfit" DROP CONSTRAINT "outfit_plan_look_id_foreign";--> statement-breakpoint
ALTER TABLE "option_group" DROP CONSTRAINT "option_group_plan_item_id_unique";--> statement-breakpoint
DROP INDEX "outfit_plan_look_id_unique";--> statement-breakpoint
ALTER TABLE "outfit" DROP CONSTRAINT "outfit_proposal_check";--> statement-breakpoint
ALTER TABLE "option_group" DROP COLUMN "plan_item_id";--> statement-breakpoint
ALTER TABLE "outfit" DROP COLUMN "plan_look_id";--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_proposal_check" CHECK (("outfit"."proposed_at" is null) = ("outfit"."reaction" is null) and ("outfit"."proposed_at" is not null or ("outfit"."proposed_by_token_id" is null and "outfit"."proposal_note" is null and "outfit"."owner_note" is null and "outfit"."reacted_at" is null)));--> statement-breakpoint
DROP TABLE "plan_look_slot";--> statement-breakpoint
DROP TABLE "plan_look";--> statement-breakpoint
DROP TABLE "plan_item_candidate";--> statement-breakpoint
DROP TABLE "plan_item_rejection";--> statement-breakpoint
DROP TABLE "plan_item";--> statement-breakpoint
DROP TABLE "wardrobe_plan";

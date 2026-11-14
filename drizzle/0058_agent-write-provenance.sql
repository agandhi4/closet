SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #682: what the owner's agent did over MCP carries the token that made it.
-- A calendar entry's choice gains 'agent' with its token, a trip outfit its
-- token; garment.suggested_by_token_id and outfit.proposed_by_token_id now
-- name the token that made any agent-made row, not only a suggestion's or a
-- proposal's, so their checks drop the token. The garment's becomes a soft
-- reference (no foreign key): a grantee's agent can stamp another's garment,
-- and deleting the grantee must not erase that an agent made it. No
-- backfill: older rows are the person's.
ALTER TABLE "garment" DROP CONSTRAINT "garment_suggestion_check";--> statement-breakpoint
ALTER TABLE "outfit" DROP CONSTRAINT "outfit_proposal_check";--> statement-breakpoint
ALTER TABLE "outfit_calendar" DROP CONSTRAINT "outfit_calendar_planned_by_check";--> statement-breakpoint
ALTER TABLE "garment" DROP CONSTRAINT "garment_suggested_by_token_id_foreign";
--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD COLUMN "planned_by_token_id" integer;--> statement-breakpoint
ALTER TABLE "trip_outfit" ADD COLUMN "planned_by_token_id" integer;--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_planned_by_token_id_foreign" FOREIGN KEY ("planned_by_token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "trip_outfit" ADD CONSTRAINT "trip_outfit_planned_by_token_id_foreign" FOREIGN KEY ("planned_by_token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "outfit_calendar_planned_by_token_id_index" ON "outfit_calendar" USING btree ("planned_by_token_id");--> statement-breakpoint
CREATE INDEX "trip_outfit_planned_by_token_id_index" ON "trip_outfit" USING btree ("planned_by_token_id");--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_suggestion_check" CHECK ("garment"."suggested_at" is not null or ("garment"."suggestion_group_id" is null and "garment"."suggestion_note" is null and "garment"."suggestion_rank" is null));--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_proposal_check" CHECK (("outfit"."proposed_at" is null) = ("outfit"."reaction" is null) and ("outfit"."proposed_at" is not null or ("outfit"."proposal_note" is null and "outfit"."owner_note" is null and "outfit"."reacted_at" is null)));--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_planned_by_token_id_check" CHECK ("outfit_calendar"."planned_by" = 'agent' or "outfit_calendar"."planned_by_token_id" is null);--> statement-breakpoint
ALTER TABLE "outfit_calendar" ADD CONSTRAINT "outfit_calendar_planned_by_check" CHECK ("outfit_calendar"."planned_by" in ('auto', 'agent', 'user'));
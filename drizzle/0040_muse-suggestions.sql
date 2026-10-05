CREATE TABLE "option_group" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"budget" numeric(10, 2),
	"note" text,
	"suggested_by_token_id" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_garment_id" integer,
	"dismissed_reason" text,
	"owner_note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_item_id" integer,
	CONSTRAINT "option_group_plan_item_id_unique" UNIQUE("plan_item_id"),
	CONSTRAINT "option_group_status_check" CHECK ("option_group"."status" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "option_group_name_check" CHECK (length(trim("option_group"."name")) > 0),
	CONSTRAINT "option_group_budget_check" CHECK ("option_group"."budget" >= 0),
	CONSTRAINT "option_group_decided_at_check" CHECK (("option_group"."status" = 'open') = ("option_group"."decided_at" is null)),
	CONSTRAINT "option_group_dismissed_reason_check" CHECK ("option_group"."dismissed_reason" is null or ("option_group"."status" = 'dismissed' and "option_group"."dismissed_reason" in ('too_pricey', 'colour', 'style', 'already_have', 'fit_size', 'not_now', 'chose_another', 'returned'))),
	CONSTRAINT "option_group_resolved_garment_id_check" CHECK ("option_group"."status" = 'resolved' or "option_group"."resolved_garment_id" is null)
);
--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "suggested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "suggested_by_token_id" integer;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "suggestion_group_id" integer;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "suggestion_note" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "suggestion_rank" smallint;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "dismissed_reason" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "dismissed_note" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "suggestions_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "option_group" ADD CONSTRAINT "option_group_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "option_group" ADD CONSTRAINT "option_group_suggested_by_token_id_foreign" FOREIGN KEY ("suggested_by_token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "option_group" ADD CONSTRAINT "option_group_resolved_garment_id_foreign" FOREIGN KEY ("resolved_garment_id") REFERENCES "public"."garment"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "option_group" ADD CONSTRAINT "option_group_plan_item_id_foreign" FOREIGN KEY ("plan_item_id") REFERENCES "public"."plan_item"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "option_group_owner_id_status_index" ON "option_group" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "option_group_suggested_by_token_id_index" ON "option_group" USING btree ("suggested_by_token_id");--> statement-breakpoint
CREATE INDEX "option_group_resolved_garment_id_index" ON "option_group" USING btree ("resolved_garment_id");--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_suggested_by_token_id_foreign" FOREIGN KEY ("suggested_by_token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_suggestion_group_id_foreign" FOREIGN KEY ("suggestion_group_id") REFERENCES "public"."option_group"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "garment_suggested_by_token_id_index" ON "garment" USING btree ("suggested_by_token_id");--> statement-breakpoint
CREATE INDEX "garment_suggestion_group_id_index" ON "garment" USING btree ("suggestion_group_id");--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_suggestion_check" CHECK ("garment"."suggested_at" is not null or ("garment"."suggested_by_token_id" is null and "garment"."suggestion_group_id" is null and "garment"."suggestion_note" is null and "garment"."suggestion_rank" is null));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_suggestion_note_check" CHECK ("garment"."suggestion_note" is null or length(trim("garment"."suggestion_note")) > 0);--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_suggestion_rank_check" CHECK ("garment"."suggestion_rank" between 1 and 5);--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_dismissed_reason_check" CHECK ("garment"."dismissed_reason" in ('too_pricey', 'colour', 'style', 'already_have', 'fit_size', 'not_now', 'chose_another', 'returned'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_dismissed_check" CHECK ("garment"."dismissed_at" is not null or ("garment"."dismissed_reason" is null and "garment"."dismissed_note" is null));--> statement-breakpoint
-- Data (#333, docs/plans/2026-10-05-muse-suggestions.md section 8): the
-- plans the owner's agent drafted (drafted_by_token_id set; owner decision,
-- 2026-10-05: an owner's own plan, the demo persona's included, is left
-- alone and its candidates stay plain wishlist items). Their items become
-- option groups, their candidates the groups' suggestions (already
-- wishlist garments), their rejections dismissed suggestions. The plan
-- tables are read, never changed: the plans pages keep working until #337
-- removes them. Aborts, naming the problem, on a candidate of another
-- owner: no app path makes one, so it would be corruption to surface, not
-- skip.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM plan_item_candidate c
    JOIN plan_item i ON i.id = c.plan_item_id
    JOIN wardrobe_plan p ON p.id = i.plan_id
    JOIN garment g ON g.id = c.garment_id
    WHERE p.drafted_by_token_id IS NOT NULL AND g.owner_id <> p.owner_id
  ) THEN
    RAISE EXCEPTION '0040: a plan candidate is not its plan owner''s garment';
  END IF;
END $$;
--> statement-breakpoint
-- Each drafted item is one need: its name (else its type or category),
-- budget, the agent's note and the owner's, the plan's token. A declined
-- item ("Don't buy") is a dismissed need; every other review state is open
-- (proposed and accepted alike: matching targets are retired). An item
-- without candidates is a need still being looked for. A garment linked to
-- several items belongs to one: the lowest plan id's (a duplicated plan
-- copies its links, and the original is older), then the lowest item id's.
-- An item every candidate of which belongs to another plan's item is that
-- item's copy and is left out; two items of one plan sharing a garment
-- both stay (the later one without it).
CREATE TEMPORARY TABLE "muse_claim" ON COMMIT DROP AS
  SELECT DISTINCT ON (c.garment_id) c.garment_id, c.plan_item_id, i.plan_id
  FROM plan_item_candidate c
  JOIN plan_item i ON i.id = c.plan_item_id
  JOIN wardrobe_plan p ON p.id = i.plan_id
  WHERE p.drafted_by_token_id IS NOT NULL
  ORDER BY c.garment_id, i.plan_id, c.plan_item_id;
--> statement-breakpoint
INSERT INTO "option_group" (
  "owner_id", "name", "budget", "note", "suggested_by_token_id", "status",
  "dismissed_reason", "owner_note", "decided_at", "created_at", "plan_item_id"
)
SELECT p.owner_id,
  coalesce(nullif(trim(i.name), ''), initcap(coalesce(i.type, i.category))),
  i.budget, i.note, p.drafted_by_token_id,
  CASE WHEN i.review = 'declined' THEN 'dismissed' ELSE 'open' END,
  CASE WHEN i.review = 'declined' THEN 'not_now' END,
  i.owner_note,
  CASE WHEN i.review = 'declined' THEN now() END,
  i.created_at, i.id
FROM plan_item i
JOIN wardrobe_plan p ON p.id = i.plan_id
WHERE p.drafted_by_token_id IS NOT NULL
  -- A copy: it has candidates, and none of them belongs to its own plan.
  AND NOT (
    EXISTS (SELECT 1 FROM plan_item_candidate c WHERE c.plan_item_id = i.id)
    AND NOT EXISTS (
      SELECT 1 FROM plan_item_candidate c
      JOIN muse_claim claim ON claim.garment_id = c.garment_id
      WHERE c.plan_item_id = i.id AND claim.plan_id = i.plan_id
    )
  )
ORDER BY i.id;
--> statement-breakpoint
-- Each claimed candidate becomes its group's suggestion: the agent's note
-- and rank, the plan's token, and when it was linked.
UPDATE "garment" g SET
  "suggested_at" = c.created_at,
  "suggested_by_token_id" = og.suggested_by_token_id,
  "suggestion_group_id" = og.id,
  "suggestion_note" = c.note,
  "suggestion_rank" = c.rank
FROM muse_claim claim
JOIN plan_item_candidate c
  ON c.plan_item_id = claim.plan_item_id AND c.garment_id = claim.garment_id
JOIN "option_group" og ON og.plan_item_id = claim.plan_item_id
WHERE g.id = claim.garment_id;
--> statement-breakpoint
-- A need whose candidate was already bought is resolved by it (the best
-- ranked, then the oldest, if several were), and its other open picks are
-- set aside as "chose another" at the same instant, as a choice does.
UPDATE "option_group" og SET
  "status" = 'resolved', "resolved_garment_id" = bought.id, "decided_at" = now()
FROM (
  SELECT DISTINCT ON (suggestion_group_id) suggestion_group_id, id
  FROM "garment"
  WHERE suggestion_group_id IS NOT NULL AND status <> 'wishlist'
  ORDER BY suggestion_group_id, suggestion_rank NULLS LAST, id
) bought
WHERE og.id = bought.suggestion_group_id AND og.status = 'open';
--> statement-breakpoint
UPDATE "garment" g SET "dismissed_at" = og.decided_at, "dismissed_reason" = 'chose_another'
FROM "option_group" og
WHERE g.suggestion_group_id = og.id AND og.status = 'resolved'
  AND g.status = 'wishlist' AND g.dismissed_at IS NULL;
--> statement-breakpoint
-- A rejected candidate ("Not this one") was deleted from the wishlist with
-- it, leaving a snapshot: it comes back as a dismissed suggestion without a
-- photo, its free-text reason as the note (no reason of the fixed set), so
-- the agent can still be kept from proposing it again. Only a migrated
-- item's (its group exists).
INSERT INTO "garment" (
  "shareable_id", "name", "category", "brand", "source_url", "price",
  "owner_id", "status", "suggested_at", "suggested_by_token_id",
  "suggestion_group_id", "dismissed_at", "dismissed_note"
)
SELECT gen_random_uuid()::text, r.name, i.category, r.brand,
  -- A link the garment's check would refuse is dropped, not a failed boot.
  CASE WHEN r.url ~* '^https?://' THEN r.url END, r.price,
  og.owner_id, 'wishlist', r.created_at, og.suggested_by_token_id,
  og.id, r.created_at, nullif(trim(r.reason), '')
FROM plan_item_rejection r
JOIN plan_item i ON i.id = r.plan_item_id
JOIN "option_group" og ON og.plan_item_id = i.id
ORDER BY r.id;

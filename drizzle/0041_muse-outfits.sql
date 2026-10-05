ALTER TABLE "outfit" ADD COLUMN "proposed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "proposed_by_token_id" integer;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "proposal_note" text;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "reaction" text;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "owner_note" text;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "dismissed_reason" text;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "reacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outfit" ADD COLUMN "plan_look_id" integer;--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_proposed_by_token_id_foreign" FOREIGN KEY ("proposed_by_token_id") REFERENCES "public"."personal_access_token"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_plan_look_id_foreign" FOREIGN KEY ("plan_look_id") REFERENCES "public"."plan_look"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "outfit_proposed_by_token_id_index" ON "outfit" USING btree ("proposed_by_token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outfit_plan_look_id_unique" ON "outfit" USING btree ("plan_look_id");--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_proposal_check" CHECK (("outfit"."proposed_at" is null) = ("outfit"."reaction" is null) and ("outfit"."proposed_at" is not null or ("outfit"."proposed_by_token_id" is null and "outfit"."proposal_note" is null and "outfit"."owner_note" is null and "outfit"."reacted_at" is null and "outfit"."plan_look_id" is null)));--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_reaction_check" CHECK ("outfit"."reaction" in ('proposed', 'loved', 'revise', 'declined'));--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_proposal_note_check" CHECK ("outfit"."proposal_note" is null or length(trim("outfit"."proposal_note")) > 0);--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_owner_note_check" CHECK ("outfit"."reaction" is distinct from 'revise' or "outfit"."owner_note" is not null);--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_dismissed_reason_check" CHECK ("outfit"."dismissed_reason" is null or ("outfit"."reaction" = 'declined' and "outfit"."dismissed_reason" in ('too_pricey', 'colour', 'style', 'already_have', 'not_now')));--> statement-breakpoint
-- Data (#335, docs/plans/2026-10-05-muse-suggestions.md section 8): the
-- looks of the plans the owner's agent drafted (drafted_by_token_id set,
-- 0040's rule: an owner's own plan, the demo persona's included, is left
-- alone) become Muse outfits: ordinary outfits with the look's slots, the
-- agent's note and token, and the owner's reaction. Rejections are not
-- touched (0040 made them dismissed suggestions; #337). The plan tables
-- are read, never changed. Aborts, naming the problem, on a look slot
-- holding another owner's garment: no app path makes one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM plan_look_slot s
    JOIN plan_look l ON l.id = s.look_id
    JOIN wardrobe_plan p ON p.id = l.plan_id
    JOIN garment g ON g.id = s.garment_id
    WHERE p.drafted_by_token_id IS NOT NULL AND g.owner_id <> p.owner_id
  ) THEN
    RAISE EXCEPTION '0041: a plan look holds a garment that is not its plan owner''s';
  END IF;
END $$;
--> statement-breakpoint
-- Each drafted look, decided once: `garments` is its set of chosen
-- garments (empty slots aside), the key of "one outfit per garment set"
-- (createOutfit's rule). A look already saved as an outfit (#292) makes no
-- outfit: that outfit takes the provenance, as the owner's (`loved`), the
-- earliest look of it only. A look whose set is an outfit the owner has,
-- or an earlier look's (lowest plan id, then look id; a copied plan), is
-- skipped, and so is one with no garment at all.
CREATE TEMP TABLE muse_look ON COMMIT DROP AS
WITH drafted AS (
  SELECT l.id, l.plan_id, l.name, l.note, l.reaction, l.owner_note,
    l.outfit_id, l.created_at, p.owner_id, p.drafted_by_token_id AS token_id,
    (SELECT array_agg(DISTINCT s.garment_id ORDER BY s.garment_id)
      FROM plan_look_slot s
      WHERE s.look_id = l.id AND s.garment_id IS NOT NULL) AS garments
  FROM plan_look l
  JOIN wardrobe_plan p ON p.id = l.plan_id
  WHERE p.drafted_by_token_id IS NOT NULL
), outfit_sets AS (
  SELECT o.owner_id,
    array_agg(DISTINCT s.garment_id ORDER BY s.garment_id) AS garments
  FROM outfit o
  JOIN outfit_slot s ON s.outfit_id = o.id AND s.garment_id IS NOT NULL
  GROUP BY o.id, o.owner_id
), ranked AS (
  SELECT d.*,
    row_number() OVER (PARTITION BY d.owner_id, d.garments ORDER BY d.plan_id, d.id) AS set_rank,
    row_number() OVER (PARTITION BY d.outfit_id ORDER BY d.plan_id, d.id) AS saved_rank
  FROM drafted d
)
SELECT r.*,
  CASE
    WHEN r.outfit_id IS NOT NULL THEN
      CASE WHEN r.saved_rank = 1 THEN 'stamp' ELSE 'skip' END
    WHEN r.garments IS NULL THEN 'skip'
    WHEN r.set_rank > 1 THEN 'skip'
    WHEN EXISTS (
      SELECT 1 FROM outfit_sets os
      WHERE os.owner_id = r.owner_id AND os.garments = r.garments
    ) THEN 'skip'
    ELSE 'create'
  END AS decision
FROM ranked r;
--> statement-breakpoint
-- A look saved as an outfit: that outfit, the owner's already, is Muse's
-- proposal they loved.
UPDATE outfit o SET
  proposed_at = m.created_at,
  proposed_by_token_id = m.token_id,
  proposal_note = nullif(trim(m.note), ''),
  reaction = 'loved',
  plan_look_id = m.id
FROM muse_look m
WHERE m.decision = 'stamp' AND o.id = m.outfit_id;
--> statement-breakpoint
-- Every other look: a new outfit with the look's slots, position for
-- position (an emptied slot stays empty), in one statement.
WITH created AS (
  INSERT INTO outfit (shareable_id, name, notes, owner_id, proposed_at,
    proposed_by_token_id, proposal_note, reaction, owner_note, plan_look_id)
  SELECT gen_random_uuid()::text, m.name, NULL, m.owner_id, m.created_at,
    m.token_id, nullif(trim(m.note), ''), m.reaction, m.owner_note, m.id
  FROM muse_look m
  WHERE m.decision = 'create'
  RETURNING id, plan_look_id
)
INSERT INTO outfit_slot (outfit_id, position, category, garment_id)
SELECT c.id, s.position, s.category, s.garment_id
FROM created c
JOIN plan_look_slot s ON s.look_id = c.plan_look_id;
--> statement-breakpoint
-- What was decided happened: every look to create or stamp is an
-- outfit's, every new outfit's slots are its look's exactly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM muse_look m
    WHERE m.decision <> 'skip'
      AND NOT EXISTS (SELECT 1 FROM outfit o WHERE o.plan_look_id = m.id)
  ) THEN
    RAISE EXCEPTION '0041: a drafted look became no outfit';
  END IF;
  IF EXISTS (
    SELECT 1 FROM muse_look m
    JOIN outfit o ON o.plan_look_id = m.id
    WHERE m.decision = 'create' AND EXISTS (
      (SELECT position, category, garment_id FROM plan_look_slot WHERE look_id = m.id
        EXCEPT SELECT position, category, garment_id FROM outfit_slot WHERE outfit_id = o.id)
      UNION ALL
      (SELECT position, category, garment_id FROM outfit_slot WHERE outfit_id = o.id
        EXCEPT SELECT position, category, garment_id FROM plan_look_slot WHERE look_id = m.id)
    )
  ) THEN
    RAISE EXCEPTION '0041: a new outfit''s slots are not its look''s';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE muse_look;

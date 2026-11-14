-- #659: who made each outfit (src/wardrobe/outfit-origin.ts). The ALTERs take the
-- outfit table's ACCESS EXCLUSIVE lock until the boot's migration transaction commits;
-- behind a long writer they give up after 5 s and the boot is retried (as 0051).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A constant default: metadata only, no rewrite. Every outfit starts as the
-- person's, the safe answer (it stays on Saved); only what is provable below moves.
ALTER TABLE "outfit" ADD COLUMN "origin" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "outfit" ADD CONSTRAINT "outfit_origin_check" CHECK ("outfit"."origin" in ('person', 'agent', 'idea', 'planner'));--> statement-breakpoint
-- The provable origins. `agent`: Muse's proposals. `planner`: "Plan my week"
-- created it (week_plan_entry.outfit_created, which every person's save of it
-- cleared, adoptOutfit) and nobody touched it since: no notes, and its
-- name still ideaName's, its garments' names in slot order (an unnamed garment,
-- a truncated name or a rename is a person's: left alone). Not inferred: `idea`
-- ("Wear this" and a gallery Save are named alike) and planner outfits whose
-- entries are gone (no evidence left); both stay `person`, visible.
CREATE TEMPORARY TABLE "outfit_origin_backfill" ON COMMIT DROP AS
SELECT "id", "owner_id", 'agent'::text AS "origin"
FROM "outfit"
WHERE "proposed_at" IS NOT NULL
UNION ALL
SELECT o."id", o."owner_id", 'planner'
FROM "outfit" o
WHERE o."proposed_at" IS NULL
  AND o."notes" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "week_plan_entry" e
    JOIN "outfit_calendar" c ON c."id" = e."entry_id"
    WHERE c."outfit_id" = o."id" AND e."outfit_created"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "outfit_slot" s
    LEFT JOIN "garment" g ON g."id" = s."garment_id"
    WHERE s."outfit_id" = o."id" AND g."name" IS NULL
  )
  AND o."name" = (
    SELECT string_agg(g."name", ', ' ORDER BY s."position")
    FROM "outfit_slot" s
    JOIN "garment" g ON g."id" = s."garment_id"
    WHERE s."outfit_id" = o."id"
  );--> statement-breakpoint
-- The updates are synced writes: the sync triggers (0052) refuse them without the
-- owner lock's mark. This is ownerLockSelect's statement (src/db/owner-lock.ts)
-- written out, the one shape every writer's lock has: the owners the updates
-- touch locked in id order, then each one marked ",<id>," above the lock rows
-- (the lock_timeout is the header's). The trigger reads that format; the
-- migrations spec runs this file against rows to prove it.
SELECT "owner_row"."id",
  set_config(
    'closet.locked_owners',
    coalesce(current_setting('closet.locked_owners', true), '') || ',' || "owner_row"."id" || ',',
    true
  ) AS "marked"
FROM (
  SELECT "id" FROM "user"
  WHERE "id" IN (SELECT "owner_id" FROM "outfit_origin_backfill")
  ORDER BY "id"
  FOR NO KEY UPDATE OF "user"
) AS "owner_row";--> statement-breakpoint
UPDATE "outfit" o
SET "origin" = b."origin"
FROM "outfit_origin_backfill" b
WHERE o."id" = b."id";

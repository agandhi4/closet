ALTER TABLE "inspiration" ADD COLUMN "next_piece_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "inspiration" SET "next_piece_position" = "last"."next" FROM (SELECT "inspiration_id", max("position") + 1 AS "next" FROM "inspiration_piece" GROUP BY "inspiration_id") AS "last" WHERE "inspiration"."id" = "last"."inspiration_id";

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #653: since when nothing of a photo is left in storage to show (its
-- original and its row's nobg and thumb all gone: a database restored ahead
-- of its storage). Nullable, no default: no table rewrite.
ALTER TABLE "file" ADD COLUMN "original_missing_since" timestamp with time zone;
--> statement-breakpoint
-- 0052's function, restated whole, with the mark added: a photo whose
-- bytes went (or came back) changes what its garment shows, so devices and
-- the API must learn of it through the garment's revision.
-- A garment's photo: only a new version, cutout status or missing mark
-- touches the garment showing it (a cutout claim changes only the lease).
-- A photo no garment shows (a selfie's, a look's, an orphan) touches
-- nothing and needs no lock. An insert or delete reaches the garment
-- through its photo_id.
-- The touch is an UPDATE of the garment, whose closet_sync_stamp checks
-- the owner's mark: it needs no lock of its own on the garment row, since
-- every writer of a garment's photo row took the owner lock first
-- (garmentOwnersOf, src/cutout/queries.ts; writeMissingMarks), and
-- every other writer of that garment waits on the same owner lock.
CREATE OR REPLACE FUNCTION closet_sync_touch_photo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE garment SET updated_at = now()
  WHERE photo_id IN (
    SELECT n.id FROM new_rows n JOIN old_rows o ON o.id = n.id
    WHERE n.version IS DISTINCT FROM o.version
      OR n.cutout_status IS DISTINCT FROM o.cutout_status
      OR n.original_missing_since IS DISTINCT FROM o.original_missing_since
  );
  RETURN NULL;
END $$;

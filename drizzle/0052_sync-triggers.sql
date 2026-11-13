-- The sync triggers (#196a-2; docs/plans/2026-11-12-json-api.md section 7).
-- Hand-written (drizzle-kit generate --custom): Drizzle does not model
-- functions or triggers, so the drift test cannot see them;
-- test/integration/sync-triggers.spec.ts holds pg_trigger to
-- src/db/sync-tables.ts. drizzle-orm's migrator splits a file only at its
-- breakpoints, so each $$ body below is one statement.
--
-- Needs #196a-1 deployed first (every synced writer takes its owner lock,
-- src/db/owner-lock.ts): the guard below refuses a write without it, so the
-- previous release must already lock. Rolling back two releases onto this
-- schema is unsupported.
--
-- Every CREATE TRIGGER takes its table's SHARE ROW EXCLUSIVE lock until the
-- boot's migration transaction commits; behind a long writer it gives up
-- after 5 s and the boot fails and is retried, rather than queueing every
-- request behind it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- The owner's revision for this transaction's writes: the strict guard (a
-- write to a synced table without the owner's lock mark raises), then the
-- owner's cached revision, or one bump of user.revision cached for the rest
-- of the transaction (`closet.revision_<id>`, SET LOCAL: per owner, since
-- one transaction may write two owners' rows; a GUC name part may not start
-- with a digit, hence the underscore). One transaction is one revision per
-- owner; a savepoint rolled back reverts the bump and the cache together.
-- The bump re-takes the owner lock the writer holds, so it never waits.
-- Null when the owner is gone (deleted in this transaction, 'gone' below):
-- nothing to stamp, no tombstone.
CREATE FUNCTION closet_sync_revision(owner integer, relation text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  cache text := 'closet.revision_' || owner;
  cached text := current_setting(cache, true);
  stamped bigint;
BEGIN
  IF cached = 'gone' THEN
    RETURN NULL;
  END IF;
  IF cached <> '' THEN
    RETURN cached::bigint;
  END IF;
  IF position(',' || owner || ',' IN coalesce(current_setting('closet.locked_owners', true), '')) = 0 THEN
    IF EXISTS (SELECT 1 FROM "user" WHERE id = owner) THEN
      RAISE EXCEPTION 'owner lock not held: a write to % for owner % (ownerLockCte, src/db/owner-lock.ts)', relation, owner;
    END IF;
    RETURN NULL;
  END IF;
  UPDATE "user" SET revision = revision + 1 WHERE id = owner RETURNING revision INTO stamped;
  PERFORM set_config(cache, coalesce(stamped::text, 'gone'), true);
  RETURN stamped;
END $$;
--> statement-breakpoint
-- A root's insert or update: its owner's revision, and on update the time.
-- TG_ARGV[0] is the owner's column. A gone owner keeps the old revision
-- (the row goes with the owner's cascade).
--
-- An insert carrying a client id that has a tombstone is a replayed create
-- of a row since deleted: refused with SQLSTATE CL410 (isDeletedClientId,
-- src/db/errors.ts; the route's 410), never resurrected. Checked here, not
-- in the writer's statement: a trigger's query takes a fresh snapshot, so
-- it sees a tombstone the owner lock's holder committed while this writer
-- waited, which the writer's own statement (its snapshot taken before the
-- wait) would not.
CREATE FUNCTION closet_sync_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  written jsonb := to_jsonb(NEW);
  owner integer := (written ->> TG_ARGV[0])::integer;
  stamped bigint := closet_sync_revision(owner, TG_TABLE_NAME);
  client uuid := (written ->> 'client_id')::uuid;
BEGIN
  IF TG_OP = 'INSERT' AND client IS NOT NULL AND EXISTS (
    SELECT 1 FROM sync_tombstone t
    WHERE t.owner_id = owner AND t.client_id = client AND t.resource = TG_TABLE_NAME
  ) THEN
    RAISE EXCEPTION 'deleted client id: % % was deleted, not created again', TG_TABLE_NAME, client
      USING ERRCODE = 'CL410';
  END IF;
  NEW.revision := coalesce(stamped, NEW.revision);
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A root's delete, cascades included: its tombstone, with the client's id
-- (a replayed create of it is refused). TG_ARGV: the owner's column, the
-- row's id column. None for a row deleted with its owner.
CREATE FUNCTION closet_sync_tombstone() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  deleted jsonb := to_jsonb(OLD);
  owner integer := (deleted ->> TG_ARGV[0])::integer;
  stamped bigint := closet_sync_revision(owner, TG_TABLE_NAME);
BEGIN
  IF stamped IS NOT NULL THEN
    INSERT INTO sync_tombstone (owner_id, resource, resource_id, client_id, revision)
    VALUES (owner, TG_TABLE_NAME, (deleted ->> TG_ARGV[1])::integer, (deleted ->> 'client_id')::uuid, stamped);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- A child's statement: each parent row it wrote under, touched once
-- (updated_at), which the parent's own closet_sync_stamp stamps; a parent
-- deleted in the same cascade updates nothing. TG_ARGV: the child's column,
-- the parent table, the parent's matching column. One trigger per event:
-- a transition table trigger takes one event.
CREATE FUNCTION closet_sync_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  written text := CASE TG_OP
    WHEN 'INSERT' THEN format('SELECT %I FROM new_rows', TG_ARGV[0])
    WHEN 'DELETE' THEN format('SELECT %I FROM old_rows', TG_ARGV[0])
    ELSE format('SELECT %1$I FROM new_rows UNION SELECT %1$I FROM old_rows', TG_ARGV[0])
  END;
BEGIN
  EXECUTE format('UPDATE %I SET updated_at = now() WHERE %I IN (%s)', TG_ARGV[1], TG_ARGV[2], written);
  RETURN NULL;
END $$;
--> statement-breakpoint
-- A garment's photo: only a new version or cutout status touches the
-- garment showing it (a cutout claim changes only the lease). A photo no
-- garment shows (a selfie's, a look's, an orphan) touches nothing and needs
-- no lock. An insert or delete reaches the garment through its photo_id.
CREATE FUNCTION closet_sync_touch_photo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE garment SET updated_at = now()
  WHERE photo_id IN (
    SELECT n.id FROM new_rows n JOIN old_rows o ON o.id = n.id
    WHERE n.version IS DISTINCT FROM o.version
      OR n.cutout_status IS DISTINCT FROM o.cutout_status
  );
  RETURN NULL;
END $$;
--> statement-breakpoint
-- The week template has no row of its own: its statement stamps each
-- owner's user.week_template_revision once (computed before the update: the
-- bump is an update of the same row).
CREATE FUNCTION closet_sync_week_template() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  written text := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT user_id FROM new_rows'
    WHEN 'DELETE' THEN 'SELECT user_id FROM old_rows'
    ELSE 'SELECT user_id FROM new_rows UNION SELECT user_id FROM old_rows'
  END;
  owner integer;
  stamped bigint;
BEGIN
  FOR owner IN EXECUTE 'SELECT DISTINCT user_id FROM (' || written || ') AS written ORDER BY user_id' LOOP
    stamped := closet_sync_revision(owner, TG_TABLE_NAME);
    IF stamped IS NOT NULL THEN
      UPDATE "user" SET week_template_revision = stamped WHERE id = owner;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- An account deleted: its revision is 'gone' for the rest of the
-- transaction, so its cascades stamp nothing and write no tombstone (the
-- old ones cascade with it).
CREATE FUNCTION closet_sync_owner_gone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('closet.revision_' || OLD.id, 'gone', true);
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER closet_sync_owner_gone BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION closet_sync_owner_gone();
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "garment" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "garment" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "outfit" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "outfit" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "outfit_calendar" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "outfit_calendar" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "garment_wear" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "garment_wear" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "selfie" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "selfie" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "capsule" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "capsule" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "trip" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "trip" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "week_plan" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('owner_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "week_plan" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('owner_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "brand_size" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('user_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "brand_size" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('user_id', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "style_profile" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('user_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "style_profile" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('user_id', 'user_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_stamp BEFORE INSERT OR UPDATE ON "body_measurements" FOR EACH ROW EXECUTE FUNCTION closet_sync_stamp('user_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_tombstone AFTER DELETE ON "body_measurements" FOR EACH ROW EXECUTE FUNCTION closet_sync_tombstone('user_id', 'user_id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "outfit_slot" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('outfit_id', 'outfit', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "outfit_slot" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('outfit_id', 'outfit', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "outfit_slot" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('outfit_id', 'outfit', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "trip_item" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "trip_item" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "trip_item" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "trip_outfit" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "trip_outfit" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "trip_outfit" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "trip_garment_packed" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "trip_garment_packed" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "trip_garment_packed" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('trip_id', 'trip', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "capsule_garment" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('capsule_id', 'capsule', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "capsule_garment" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('capsule_id', 'capsule', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "capsule_garment" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('capsule_id', 'capsule', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "week_plan_entry" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('week_plan_id', 'week_plan', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "week_plan_entry" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('week_plan_id', 'week_plan', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "week_plan_entry" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('week_plan_id', 'week_plan', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_insert AFTER INSERT ON "garment_repair" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('garment_id', 'garment', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "garment_repair" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('garment_id', 'garment', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_delete AFTER DELETE ON "garment_repair" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch('garment_id', 'garment', 'id');
--> statement-breakpoint
CREATE TRIGGER closet_sync_touch_update AFTER UPDATE ON "file" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_touch_photo();
--> statement-breakpoint
CREATE TRIGGER closet_sync_week_template_insert AFTER INSERT ON "week_template" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_week_template();
--> statement-breakpoint
CREATE TRIGGER closet_sync_week_template_update AFTER UPDATE ON "week_template" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_week_template();
--> statement-breakpoint
CREATE TRIGGER closet_sync_week_template_delete AFTER DELETE ON "week_template" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION closet_sync_week_template();

-- MINION native single-id model: make company.id === hub organization id so the
-- hub needs no separate org→company mapping table/column. Numbered for the
-- deployed pre-upstream-merge fork (lands after 0056). The post-merge branch
-- carries the equivalent as 0103; reconcile there with IF-guards.
--
-- Step 1: ensure every FK that references companies.id has ON UPDATE CASCADE so a
-- primary-key rewrite propagates to all children atomically. Name-agnostic and
-- onDelete-preserving. Idempotent: skips constraints that already cascade.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname AS name,
           con.conrelid::regclass::text AS tbl,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class ref ON ref.oid = con.confrelid
    WHERE con.contype = 'f'
      AND ref.relname = 'companies'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%ON UPDATE CASCADE%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.name);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON UPDATE CASCADE',
                   r.tbl, r.name, r.def);
  END LOOP;
END $$;--> statement-breakpoint

-- Step 2: rewrite the two existing prod companies' primary keys to their hub org
-- ids. ON UPDATE CASCADE (step 1) propagates to every child row. Guarded so it is
-- a safe no-op on fresh/dev DBs (old id absent) and on re-run (new id present).
-- FACES SCULPTORS: company fea398fc-… → org 21e0601b-…
UPDATE companies SET id = '21e0601b-f632-43fd-8414-d644af4271f4'
  WHERE id = 'fea398fc-ca7f-4dc8-be3f-38b8725a51db'
    AND NOT EXISTS (SELECT 1 FROM companies WHERE id = '21e0601b-f632-43fd-8414-d644af4271f4');--> statement-breakpoint
-- MINION: company a32be1cc-… → org c9e8dc46-…
UPDATE companies SET id = 'c9e8dc46-27b6-4aea-86a1-a2eb6b23be2d'
  WHERE id = 'a32be1cc-88e9-4207-a4da-cf818e3c91e9'
    AND NOT EXISTS (SELECT 1 FROM companies WHERE id = 'c9e8dc46-27b6-4aea-86a1-a2eb6b23be2d');

-- =====================================================================
-- Drops what a database migrated by the history before the squash still
-- carries and the baseline never creates:
--
--   * a retired feature's table, its status enum, and its flag on `teachers`
--     — the model was deleted and the unapplied baseline edited to match;
--   * `device_tokens`, whose own drop was the 46th migration of the old
--     history. The squash reproduces the schema AFTER that drop, but production
--     was last deployed from a commit carrying only the first 45, so it never
--     ran.
--
-- Every statement is IF EXISTS, so this is two different things depending on
-- where it runs:
--
--   * On a database built from these migrations — CI, a fresh Neon branch, the
--     dev and test containers — it does nothing.
--   * On production it is the only difference between the live schema and the
--     baseline being adopted. The adoption in README.md runs first; this then
--     runs inside the deploy's `migrate deploy`, after the Neon checkpoint
--     (D-95), which is the only way back from a dropped table.
--
-- ⚠️ CONTRACT, NOT EXPAND: it may only reach a database once no running code
-- maps these objects. The code production ran until the first deploy from this
-- tree maps all four, and a Prisma read that does not narrow its `select` names
-- `teachers.intro_calls_available` — so this migration ships in a release AFTER
-- that code is gone, never in the same one. See README.md.
--
-- The table goes before the enum: its `status` column uses it, and dropping the
-- table takes its indexes and both foreign keys with it.
-- =====================================================================

DROP TABLE IF EXISTS "intro_calls";

DROP TYPE IF EXISTS "IntroCallStatus";

ALTER TABLE "teachers" DROP COLUMN IF EXISTS "intro_calls_available";

DROP TABLE IF EXISTS "device_tokens";

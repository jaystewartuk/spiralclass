-- =====================================================================
-- Drops what a retired feature left behind in a database migrated by the
-- history before the squash: one table, its status enum, and a flag on
-- `teachers`.
--
-- The baseline was regenerated after that feature's model was deleted, so it
-- never creates any of the three. This migration is therefore two different
-- things depending on where it runs, and every statement is IF EXISTS so that
-- it can be both:
--
--   * On a database built from these migrations — CI, a fresh Neon branch,
--     the dev and test containers — it does nothing.
--   * On production it is the only difference between the live schema and
--     the baseline being adopted. The adoption in README.md runs first; this
--     then runs inside the deploy's `migrate deploy`, after the Neon
--     checkpoint (D-95), which is the only way back from a dropped table.
--
-- The table goes first: its `status` column uses the enum, and dropping it
-- takes its two indexes and both foreign keys with it.
-- =====================================================================

DROP TABLE IF EXISTS "intro_calls";

DROP TYPE IF EXISTS "IntroCallStatus";

ALTER TABLE "teachers" DROP COLUMN IF EXISTS "intro_calls_available";

-- D-204 follow-up: turn the materials-and-homework category on for students the
-- OLD new-student default left it off for, and who cannot have chosen that.
--
-- Until D-204, `defaultNewStudentNotificationPrefs()` stamped every new student
-- with exactly:
--
--   {"class_reminders": true, "booking_updates": true, "messages": true,
--    "class_materials": false, "expiry_reminders": false}
--
-- `class_materials` also gates the homework lifecycle (see
-- `categoryForTemplate`), and the dispatcher gates by category before it tries
-- any channel, so a teacher's materials and homework were silently dropped for
-- every such student.
--
-- `students.notification_prefs` is a bare JSON column with no marker, so a
-- stored `false` cannot be told from a student's own choice. This flips ONLY
-- rows where both of these hold, and changes ONLY `class_materials`:
--
--   1. the stored JSON equals the old default map exactly (jsonb equality: same
--      five keys, same values, no extra key such as `channelPrefs`), and
--   2. `auth_user_id IS NULL`: the student has never signed in, so has never
--      been able to open the settings page and choose anything.
--
-- Not touched, on purpose: a NULL value (already "everything on"), the roster
-- import's all-off snapshot (a teacher's decision to launch each student), any
-- row with a different shape, and any student who has signed in (the old
-- default and a saved identical choice look the same, so they are left alone).
--
-- Idempotent: after one run no row matches the WHERE clause. Data only, so it
-- adds, drops and renames nothing and is safe beside code that has not shipped.
UPDATE "students"
SET "notification_prefs" = jsonb_set("notification_prefs", '{class_materials}', 'true'::jsonb)
WHERE "auth_user_id" IS NULL
  AND "notification_prefs" = '{"class_reminders": true, "booking_updates": true, "messages": true, "class_materials": false, "expiry_reminders": false}'::jsonb;

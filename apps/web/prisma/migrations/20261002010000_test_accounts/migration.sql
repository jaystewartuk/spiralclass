-- Test accounts (D-192): an operator-set flag marking a teacher or a student as
-- the operator's own test account, so a real teacher's figures and the
-- platform's roll-ups can leave it out. Purely additive, defaulted false — the
-- code already serving reads straight past it (D-178).

ALTER TABLE "teachers" ADD COLUMN "test_account" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "students" ADD COLUMN "test_account" BOOLEAN NOT NULL DEFAULT false;

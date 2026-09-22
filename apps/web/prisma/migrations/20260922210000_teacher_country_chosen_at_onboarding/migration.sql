-- A teacher's country is captured at onboarding, not assumed at sign-up.
-- CONTRACT, NOT EXPAND: sign-up used to lean on the column default, so this
-- ships in the release after the code that writes country at onboarding only.
ALTER TABLE "teachers" ALTER COLUMN "country" DROP DEFAULT;
ALTER TABLE "teachers" ALTER COLUMN "country" DROP NOT NULL;

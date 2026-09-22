-- =====================================================================
-- SpiralClass — database invariants
--
-- The half of the schema Prisma's schema language cannot express, and
-- therefore the half `prisma migrate dev` will never write for you:
-- partial indexes, CHECK constraints, GiST exclusion constraints,
-- NOT NULL on list columns, and two plpgsql triggers.
--
-- It is hand-authored, and it is separate from the generated baseline for
-- one reason: the baseline is regenerated from `schema.prisma` whenever it
-- needs to change, and anything mixed into that file would be lost the
-- first time someone did so. Everything below has to be carried forward by
-- a person, so it lives where a person will see it.
--
-- These are business rules, not belt-and-braces. Each one is a statement
-- the application also makes, placed in the database because the database
-- is the only layer a bug, a race or a direct psql session cannot route
-- around: two requests can both pass an availability check and only one
-- can win an exclusion constraint.
--
-- When you add one of these to a table, add it here in the same change and
-- note it on the model in `schema.prisma` — the drift check
-- (`scripts/ci/integration.sh`) compares the models, so it cannot see any
-- of this.
-- =====================================================================

-- `btree_gist` lets a GiST index mix a plain equality column (teacher_id)
-- with a range operator (&&) in one exclusion constraint. Without it the
-- two constraints at the bottom of this file cannot be created at all.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------
-- 1. NOT NULL on scalar list columns
-- ---------------------------------------------------------------------
-- Prisma models a `String[]` as always-present, types it non-nullable in
-- the client, and never writes NULL to one — but it emits the COLUMN as
-- nullable, and its own `migrate diff` treats the two as equivalent. So
-- regenerating the baseline drops these four silently, with the drift
-- check reporting nothing.
--
-- They are kept because "no audiences recorded" and "the empty list" must
-- not be two states. Every reader (`toCommunityView`, the marketing
-- profile loader, the planner) consumes them as a plain array; a NULL
-- reaching a `.length` or a `.map` there is an exception, and the column
-- default already makes the empty list the natural absent value.
ALTER TABLE "teacher_marketing_profiles" ALTER COLUMN "audiences" SET NOT NULL;
ALTER TABLE "teacher_marketing_profiles" ALTER COLUMN "learner_locations" SET NOT NULL;
ALTER TABLE "teacher_marketing_profiles" ALTER COLUMN "levels" SET NOT NULL;
ALTER TABLE "teacher_share_groups" ALTER COLUMN "promo_weekdays" SET NOT NULL;

-- ---------------------------------------------------------------------
-- 2. Partial indexes
-- ---------------------------------------------------------------------
-- A partial UNIQUE index is a uniqueness rule that applies to a subset of
-- rows, which is what most of these really are: "at most one PENDING x",
-- not "at most one x". Prisma has no syntax for the predicate, so a
-- `@@unique` here would be the wrong rule rather than the same rule
-- written differently — it would forbid the second cancelled booking, the
-- second refunded payment, the second declined invitation.

-- At most one live booking per teacher per start time. Redundant with the
-- exclusion constraints below for overlap, but this one also gives the
-- booking reads their (teacher, start) lookup.
CREATE UNIQUE INDEX "bookings_teacher_slot_active_unique"
  ON "bookings" ("teacher_id", "scheduled_start")
  WHERE "status" = 'scheduled'::"BookingStatus";

-- At most one payment awaiting settlement per package: the checkout retry
-- path reuses the open payment rather than opening a second one, and a
-- duplicated pending row is how a student ends up paying twice.
CREATE UNIQUE INDEX "payment_pending_per_package_uidx"
  ON "payments" ("package_id")
  WHERE "status" = 'pending'::"PaymentStatus";

-- One open erasure request per subject, so a resubmitted request resumes
-- the existing one instead of racing a second anonymisation run.
CREATE UNIQUE INDEX "account_deletion_one_pending_per_subject"
  ON "account_deletion_requests" ("subject_type", "subject_id")
  WHERE "status" = 'pending'::"AccountDeletionStatus";

-- A reward code belongs to at most one referral. Partial rather than a
-- plain unique because the column is nullable and unset until the reward
-- is actually issued.
CREATE UNIQUE INDEX "referrals_referrer_reward_code_id_unique"
  ON "referrals" ("referrer_reward_code_id")
  WHERE "referrer_reward_code_id" IS NOT NULL;

-- One outstanding invitation per (teacher, email). Cancelled and expired
-- rows stay for the audit trail and must not block a re-invite.
CREATE UNIQUE INDEX "student_invitations_active_email_key"
  ON "student_invitations" ("teacher_id", "email")
  WHERE "status" = 'pending'::"InvitationStatus";

-- At most one testimonial per (teacher, student) — see D-151. Only
-- `student_submitted` rows carry a student_id, so the teacher's own
-- curated rows (student_id NULL) stay unconstrained, which a plain
-- `@@unique` could not express.
CREATE UNIQUE INDEX "testimonials_teacher_id_student_id_key"
  ON "testimonials" ("teacher_id", "student_id")
  WHERE "student_id" IS NOT NULL;

-- Non-unique partial indexes. Each covers a small, hot subset of a large
-- table — the disabled accounts an admin screen lists, the push
-- subscriptions that have not been revoked — so the index stays a
-- fraction of the size of the full-column version and the planner reaches
-- for it without a predicate on the indexed column itself.
CREATE INDEX "admin_users_disabled_at_idx"
  ON "admin_users" ("disabled_at") WHERE "disabled_at" IS NOT NULL;

CREATE INDEX "teachers_disabled_at_idx"
  ON "teachers" ("disabled_at") WHERE "disabled_at" IS NOT NULL;

CREATE INDEX "students_disabled_at_idx"
  ON "students" ("disabled_at") WHERE "disabled_at" IS NOT NULL;

CREATE INDEX "web_push_subscriptions_active_idx"
  ON "web_push_subscriptions" ("recipient_type", "recipient_id")
  WHERE "revoked_at" IS NULL;

-- ---------------------------------------------------------------------
-- 3. CHECK constraints
-- ---------------------------------------------------------------------

-- Money. Every amount below is an integer in the minor units of the
-- currency recorded beside it (see packages/shared/src/money.ts) — eight
-- of the ~40 curated currencies have no minor unit at all, which is why
-- the columns are not named for cents. A negative amount is not a
-- discount, it is a bug that would invert a charge.
ALTER TABLE "package_templates"
  ADD CONSTRAINT "package_templates_price_nonneg"
  CHECK ("price_minor_units" >= 0);
ALTER TABLE "package_templates"
  ADD CONSTRAINT "package_templates_transfer_price_nonnegative"
  CHECK ("transfer_price_minor_units" IS NULL OR "transfer_price_minor_units" >= 0);
ALTER TABLE "package_templates"
  ADD CONSTRAINT "package_templates_class_count_positive"
  CHECK ("class_count" > 0);
ALTER TABLE "package_templates"
  ADD CONSTRAINT "package_templates_duration_positive"
  CHECK ("class_duration_min" > 0);

ALTER TABLE "packages"
  ADD CONSTRAINT "packages_price_nonneg"
  CHECK ("price_paid_minor_units" >= 0);
ALTER TABLE "packages"
  ADD CONSTRAINT "packages_custom_price_nonneg"
  CHECK ("custom_price_minor_units" IS NULL OR "custom_price_minor_units" >= 0);
-- A package cannot be overdrawn. This is the ledger of what a student has
-- paid for and consumed; booking, cancelling and rescheduling all move it,
-- and the constraint is what makes "you have classes left" a fact rather
-- than a cached count.
ALTER TABLE "packages"
  ADD CONSTRAINT "packages_classes_used_bounds"
  CHECK ("classes_used" >= 0 AND "classes_used" <= "classes_total");
ALTER TABLE "packages"
  ADD CONSTRAINT "packages_schedule_changes_used_nonneg"
  CHECK ("schedule_changes_used" >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_nonneg"
  CHECK ("amount_minor_units" >= 0);
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_billing_country_iso_format"
  CHECK ("billing_country" IS NULL OR "billing_country" ~ '^[A-Z]{2}$');

-- The manual transfer rail, as a closed shape. A manual payment is
-- reconciled by matching the student's reference against the payee
-- instructions she was shown, so both must be present; and an instrument
-- must never be attached to a card payment, where it would name a payee
-- that had nothing to do with the charge.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reference_required_for_manual_transfer"
  CHECK ("provider" <> 'manual_transfer' OR "payment_reference" IS NOT NULL);
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_instrument_required_for_manual_transfer"
  CHECK ("provider" <> 'manual_transfer' OR "instrument_id" IS NOT NULL);
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_instrument_only_for_manual_transfer"
  CHECK ("provider" = 'manual_transfer' OR "instrument_id" IS NULL);

ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_amount_nonneg"
  CHECK ("amount_minor_units" >= 0);

-- An enabled payout instrument must be payable. `saveTeacherInstrument`
-- is the only write path and enforces the same rule, and the SQL
-- translation in `HAS_PAYOUT_RAIL_WHERE` assumes it — an enabled row with
-- no handle would make a teacher look reachable on a rail that cannot pay
-- her.
ALTER TABLE "teacher_payout_instruments"
  ADD CONSTRAINT "teacher_payout_instruments_details_required_when_enabled"
  CHECK (NOT "enabled" OR "wise_handle" IS NOT NULL);
ALTER TABLE "teacher_payout_instruments"
  ADD CONSTRAINT "teacher_payout_instruments_wise_handle_format"
  CHECK ("wise_handle" IS NULL OR "wise_handle" ~ '^[A-Za-z0-9._-]{2,32}$');

-- Time. A class that ends before it starts breaks every range query, the
-- calendar and both exclusion constraints below.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_end_after_start"
  CHECK ("scheduled_end" > "scheduled_start");
ALTER TABLE "blocked_dates"
  ADD CONSTRAINT "blocked_dates_end_after_start"
  CHECK ("ends_at" > "starts_at");
-- 0 = Sunday, matching JS `getDay()` and the availability grid.
ALTER TABLE "availability_rules"
  ADD CONSTRAINT "availability_rules_weekday_range"
  CHECK ("weekday" >= 0 AND "weekday" <= 6);

-- Identity codes, as formats rather than as free text. `country` is
-- ISO 3166-1 alpha-2 and `pricing_currency` ISO 4217 alpha-3 because both
-- are looked up in registries (`bank-schemes.ts`, `pricing-currency.ts`)
-- that answer nothing for a lower-cased or three-letter country.
ALTER TABLE "teachers"
  ADD CONSTRAINT "teachers_country_iso_format"
  CHECK ("country" ~ '^[A-Z]{2}$');
ALTER TABLE "teachers"
  ADD CONSTRAINT "teachers_pricing_currency_iso_format"
  CHECK ("pricing_currency" ~ '^[A-Z]{3}$');
ALTER TABLE "teachers"
  ADD CONSTRAINT "teachers_phone_e164_format"
  CHECK ("phone_e164" IS NULL OR "phone_e164" ~ '^\+?[0-9]{8,15}$');
ALTER TABLE "teachers"
  ADD CONSTRAINT "teachers_public_whatsapp_e164_format"
  CHECK ("public_whatsapp_e164" IS NULL OR "public_whatsapp_e164" ~ '^\+?[0-9]{8,15}$');
ALTER TABLE "teacher_subscriptions"
  ADD CONSTRAINT "teacher_subscriptions_billing_country_iso_format"
  CHECK ("billing_country" IS NULL OR "billing_country" ~ '^[A-Z]{2}$');

-- Discounts and referrals are a tagged union across nullable columns: a
-- `percent` reward carries basis points and no amount, a `fixed` reward
-- the reverse. Without the constraint a row can claim both or neither and
-- the pricing code has to guess which field to believe.
ALTER TABLE "discount_codes"
  ADD CONSTRAINT "discount_codes_value_matches_kind"
  CHECK (
    ("kind" = 'percent' AND "percent_bps" IS NOT NULL AND "amount_minor_units" IS NULL
       AND "percent_bps" > 0 AND "percent_bps" <= 10000)
    OR
    ("kind" = 'fixed' AND "amount_minor_units" IS NOT NULL AND "percent_bps" IS NULL
       AND "amount_minor_units" > 0)
  );
ALTER TABLE "discount_codes"
  ADD CONSTRAINT "discount_codes_max_redemptions_positive"
  CHECK ("max_redemptions" IS NULL OR "max_redemptions" > 0);
ALTER TABLE "discount_codes"
  ADD CONSTRAINT "discount_codes_per_student_limit_positive"
  CHECK ("per_student_limit" > 0);
ALTER TABLE "discount_redemptions"
  ADD CONSTRAINT "discount_redemptions_amount_nonneg"
  CHECK ("amount_minor_units" >= 0);

ALTER TABLE "referral_programs"
  ADD CONSTRAINT "referral_programs_referred_value_matches_kind"
  CHECK (
    ("referred_kind" = 'percent' AND "referred_percent_bps" IS NOT NULL
       AND "referred_percent_bps" > 0 AND "referred_percent_bps" <= 10000)
    OR
    ("referred_kind" = 'fixed' AND "referred_amount_minor_units" IS NOT NULL
       AND "referred_amount_minor_units" > 0)
  );
ALTER TABLE "referral_programs"
  ADD CONSTRAINT "referral_programs_referrer_value_matches_kind"
  CHECK (
    ("referrer_kind" = 'percent' AND "referrer_percent_bps" IS NOT NULL
       AND "referrer_percent_bps" > 0 AND "referrer_percent_bps" <= 10000)
    OR
    ("referrer_kind" = 'fixed' AND "referrer_amount_minor_units" IS NOT NULL
       AND "referrer_amount_minor_units" > 0)
  );
ALTER TABLE "referral_programs"
  ADD CONSTRAINT "referral_programs_reward_expiry_positive"
  CHECK ("reward_expiry_days" IS NULL OR "reward_expiry_days" > 0);
ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_discount_nonneg"
  CHECK ("referred_discount_minor_units" >= 0);

-- A verified testimonial is verified BECAUSE a student row backs it
-- (D-151). Tying the three columns together means `verified_at` cannot be
-- written without the student the claim is about, so the "Verified
-- student" badge on a public booking page can never be a value someone
-- typed.
ALTER TABLE "testimonials"
  ADD CONSTRAINT "testimonials_verified_shape"
  CHECK (
    ("source" = 'teacher_curated' AND "student_id" IS NULL AND "verified_at" IS NULL)
    OR
    ("source" = 'student_submitted' AND "student_id" IS NOT NULL AND "verified_at" IS NOT NULL)
  );

-- ---------------------------------------------------------------------
-- 4. Exclusion constraints — a double booking is unrepresentable
-- ---------------------------------------------------------------------
-- The one rule the whole product rests on. Availability is checked when a
-- slot is offered, but between that check and the INSERT another student
-- can buy the same slot; no amount of application code closes that window
-- from outside a transaction. An EXCLUDE constraint closes it inside the
-- index: Postgres refuses the second row.
--
-- `WHERE (status = 'scheduled')` scopes both to live bookings, so a
-- cancelled class frees its slot without being deleted.

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap_active"
  EXCLUDE USING gist (
    "teacher_id" WITH =,
    tstzrange("scheduled_start", "scheduled_end") WITH &&
  ) WHERE ("status" = 'scheduled');

-- The buffered version is a strict superset: it also refuses a booking
-- that lands inside the previous class's cool-down. Both are kept — the
-- narrower one is what a plain overlap violation should report, and
-- dropping it changes nothing observable.
--
-- It reads `buffered_end`, which the trigger below derives on insert.
-- That is not a generated column because `timestamptz + interval` is not
-- IMMUTABLE (it depends on the session TimeZone), and Postgres will not
-- index or generate from a non-immutable expression.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap_buffered"
  EXCLUDE USING gist (
    "teacher_id" WITH =,
    tstzrange("scheduled_start", "buffered_end") WITH &&
  ) WHERE ("status" = 'scheduled');

-- ---------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------

-- Derives bookings.buffered_end from the buffer minutes snapshotted onto
-- the row. Snapshotted rather than read from the teacher: changing her
-- buffer setting must not retroactively invalidate bookings already sold.
CREATE FUNCTION "bookings_set_buffered_end"() RETURNS trigger AS $$
BEGIN
  NEW."buffered_end" := NEW."scheduled_end" + (NEW."buffer_min_snapshot" || ' minutes')::interval;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "bookings_set_buffered_end_trigger"
  BEFORE INSERT ON "bookings"
  FOR EACH ROW
  EXECUTE FUNCTION "bookings_set_buffered_end"();

-- `overrides` is the tamper-evident audit log of every manual admin
-- action on a booking, package, payment or account (D-25). Append-only is
-- enforced here rather than in the app because the property being claimed
-- is that nobody rewrote it — including someone holding the application's
-- own database credential.
CREATE OR REPLACE FUNCTION overrides_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'overrides is append-only (tamper-evident audit log); % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER overrides_no_update
  BEFORE UPDATE ON "overrides"
  FOR EACH ROW EXECUTE FUNCTION overrides_append_only();

CREATE TRIGGER overrides_no_delete
  BEFORE DELETE ON "overrides"
  FOR EACH ROW EXECUTE FUNCTION overrides_append_only();

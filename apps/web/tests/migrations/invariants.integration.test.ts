import { expect, it } from "vitest";
import { describeIntegration, getTestPrisma } from "../_setup/test-db";

/**
 * The half of the schema nothing else checks.
 *
 * `prisma/migrations/` is two files: a baseline generated from
 * `schema.prisma`, and `20260906120100_database_invariants` — the partial
 * indexes, CHECK constraints, exclusion constraints, list-column NOT NULLs and
 * triggers Prisma's schema language cannot express (D-168).
 *
 * The migration-drift check in `scripts/ci/integration.sh` diffs MODELS, so it
 * is blind to every object below: drop the whole second migration and it still
 * reports "no model drift detected". That was survivable while the raw SQL sat
 * inside a baseline nobody regenerated. It is not survivable now that
 * regenerating the baseline is the documented way to change it — the whole
 * point of the split is that step 2 is a hand-review, and a hand-review with no
 * assertion behind it is a hope.
 *
 * So this asserts against the real catalog of a really-migrated database. It is
 * an inventory, not a behaviour suite: what each rule DOES is covered where the
 * behaviour lives (the append-only trigger in `tests/seed/cleanup`, booking
 * overlap in the booking suites). What is covered here is that the rule is
 * still THERE.
 *
 * Adding an invariant means adding it here in the same change. That is the
 * cost, and it is the intended one — an invariant nobody listed is an
 * invariant nobody notices going missing.
 */
describeIntegration("database invariants (D-168)", () => {
  // ---------------------------------------------------------------------
  // Partial indexes. Six are uniqueness rules scoped to a subset of rows —
  // "at most one PENDING x", not "at most one x" — which is exactly what a
  // Prisma `@@unique` would get wrong if anyone folded one back into the
  // model. Four are hot-subset lookups.
  // ---------------------------------------------------------------------
  const PARTIAL_INDEXES = [
    "account_deletion_one_pending_per_subject",
    "admin_users_disabled_at_idx",
    "bookings_teacher_slot_active_unique",
    "payment_pending_per_package_uidx",
    "referrals_referrer_reward_code_id_unique",
    "student_invitations_active_email_key",
    "students_disabled_at_idx",
    "teachers_disabled_at_idx",
    "testimonials_teacher_id_student_id_key",
    "web_push_subscriptions_active_idx",
  ] as const;

  // Two GiST exclusion constraints (contype 'x') and 33 CHECKs (contype 'c').
  const EXCLUSION_CONSTRAINTS = [
    "bookings_no_overlap_active",
    "bookings_no_overlap_buffered",
  ] as const;

  const CHECK_CONSTRAINTS = [
    "availability_rules_weekday_range",
    "blocked_dates_end_after_start",
    "bookings_end_after_start",
    "discount_codes_max_redemptions_positive",
    "discount_codes_per_student_limit_positive",
    "discount_codes_value_matches_kind",
    "discount_redemptions_amount_nonneg",
    "disputes_amount_nonneg",
    "package_templates_class_count_positive",
    "package_templates_duration_positive",
    "package_templates_price_nonneg",
    "package_templates_transfer_price_nonnegative",
    "packages_classes_used_bounds",
    "packages_custom_price_nonneg",
    "packages_price_nonneg",
    "packages_schedule_changes_used_nonneg",
    "payments_amount_nonneg",
    "payments_billing_country_iso_format",
    "payments_instrument_only_for_manual_transfer",
    "payments_instrument_required_for_manual_transfer",
    "payments_reference_required_for_manual_transfer",
    "referral_programs_referred_value_matches_kind",
    "referral_programs_referrer_value_matches_kind",
    "referral_programs_reward_expiry_positive",
    "referrals_discount_nonneg",
    "teacher_payout_instruments_details_required_when_enabled",
    "teacher_payout_instruments_wise_handle_format",
    "teacher_subscriptions_billing_country_iso_format",
    "teachers_country_iso_format",
    "teachers_phone_e164_format",
    "teachers_pricing_currency_iso_format",
    "teachers_public_whatsapp_e164_format",
    "testimonials_verified_shape",
  ] as const;

  // Two plpgsql functions behind three triggers.
  const TRIGGERS = [
    "bookings_set_buffered_end_trigger",
    "overrides_no_delete",
    "overrides_no_update",
  ] as const;

  // Prisma emits a scalar list column NULLABLE and its own `migrate diff`
  // treats nullable and NOT NULL as equivalent for one — so regenerating the
  // baseline drops these four with nothing reporting it. That is the case that
  // makes this file worth its maintenance.
  const NOT_NULL_LIST_COLUMNS = [
    ["teacher_marketing_profiles", "audiences"],
    ["teacher_marketing_profiles", "learner_locations"],
    ["teacher_marketing_profiles", "levels"],
    ["teacher_share_groups", "promo_weekdays"],
  ] as const;

  it("has btree_gist, without which neither exclusion constraint can exist", async () => {
    const rows = await getTestPrisma().$queryRaw<
      { extname: string }[]
    >`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`;
    expect(rows.map((r) => r.extname)).toEqual(["btree_gist"]);
  });

  it("has every partial index, each still carrying its predicate", async () => {
    const rows = await getTestPrisma().$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    for (const name of PARTIAL_INDEXES) {
      expect(byName.has(name), `partial index ${name} is missing`).toBe(true);
      // A partial index that lost its WHERE is a different rule wearing the
      // same name — and for the six unique ones, a stricter one that would
      // refuse a second cancelled booking or a second refunded payment.
      expect(byName.get(name), `${name} lost its predicate`).toContain("WHERE");
    }
  });

  it("has every CHECK and exclusion constraint", async () => {
    const rows = await getTestPrisma().$queryRaw<{ conname: string; contype: string }[]>`
      SELECT con.conname, con.contype::text AS contype
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public' AND con.contype IN ('c', 'x')
    `;
    const checks = rows.filter((r) => r.contype === "c").map((r) => r.conname);
    const excludes = rows.filter((r) => r.contype === "x").map((r) => r.conname);

    expect(checks.sort()).toEqual([...CHECK_CONSTRAINTS].sort());
    expect(excludes.sort()).toEqual([...EXCLUSION_CONSTRAINTS].sort());
  });

  it("has the three triggers, on the tables they guard", async () => {
    const rows = await getTestPrisma().$queryRaw<{ tgname: string; tbl: string }[]>`
      SELECT tgname, tgrelid::regclass::text AS tbl
      FROM pg_trigger WHERE NOT tgisinternal
    `;
    const byName = new Map(rows.map((r) => [r.tgname, r.tbl]));

    for (const name of TRIGGERS) {
      expect(byName.has(name), `trigger ${name} is missing`).toBe(true);
    }
    expect(byName.get("bookings_set_buffered_end_trigger")).toBe("bookings");
    expect(byName.get("overrides_no_update")).toBe("overrides");
    expect(byName.get("overrides_no_delete")).toBe("overrides");
  });

  it("keeps the scalar list columns NOT NULL", async () => {
    const prisma = getTestPrisma();
    for (const [table, column] of NOT_NULL_LIST_COLUMNS) {
      const rows = await prisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
      `;
      expect(rows, `${table}.${column} does not exist`).toHaveLength(1);
      expect(rows[0].is_nullable, `${table}.${column} went nullable`).toBe("NO");
    }
  });
});

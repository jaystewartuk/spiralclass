-- Packages for two (D-188): a package bought once, by one buyer, for two people
-- who take every class together. Purely additive — every new column is
-- nullable or defaulted, so the code already serving reads straight past them.

-- The teacher's suggestion for what two people pay, as a percent of the
-- one-person price. A suggestion only: prices are stored on the template.
ALTER TABLE "teachers" ADD COLUMN "two_person_price_percent" INTEGER NOT NULL DEFAULT 150;

-- The two-person price per template, on each rail. Null = not offered for two.
ALTER TABLE "package_templates" ADD COLUMN "two_person_price_minor_units" INTEGER,
ADD COLUMN "two_person_transfer_price_minor_units" INTEGER;

-- How many people a purchased package is for, and the buyer's confirmation
-- that the second person agrees to the insights terms.
ALTER TABLE "packages" ADD COLUMN "partner_consent_at" TIMESTAMPTZ,
ADD COLUMN "seats" INTEGER NOT NULL DEFAULT 1;

-- Invariants the schema language cannot say. Listed in
-- tests/migrations/invariants.integration.test.ts.

-- Below 100% the second person would make the class cheaper than one; past
-- 300% it is a typo, not a price.
ALTER TABLE "teachers"
  ADD CONSTRAINT "teachers_two_person_price_percent_range"
  CHECK ("two_person_price_percent" BETWEEN 100 AND 300);

ALTER TABLE "package_templates"
  ADD CONSTRAINT "package_templates_two_person_price_nonneg"
  CHECK ("two_person_price_minor_units" IS NULL OR "two_person_price_minor_units" >= 0);
-- A non-card price for two is a discount OFF a price for two; without one it
-- would be a two-person offer only one rail could sell.
ALTER TABLE "package_templates"
  ADD CONSTRAINT "package_templates_two_person_transfer_needs_price"
  CHECK (
    "two_person_transfer_price_minor_units" IS NULL
    OR ("two_person_price_minor_units" IS NOT NULL AND "two_person_transfer_price_minor_units" >= 0)
  );

-- One person or two. A third is a group class, which is D-149's model, not this.
ALTER TABLE "packages"
  ADD CONSTRAINT "packages_seats_one_or_two"
  CHECK ("seats" IN (1, 2));

-- The Spanish app locale is the bare language tag `es`. Rows written with a
-- regional Spanish tag collapse onto it.
UPDATE "teachers" SET "locale" = 'es' WHERE "locale" LIKE 'es-%';
UPDATE "teachers" SET "booking_page_locale" = 'es' WHERE "booking_page_locale" LIKE 'es-%';
UPDATE "students" SET "locale" = 'es' WHERE "locale" LIKE 'es-%';

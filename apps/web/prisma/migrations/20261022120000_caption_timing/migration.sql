-- Subtitle timing (D-185, D-198): how a teacher wants live subtitles cut into
-- lines, `{ "pauseMs": n, "maxChars": n }`. Purely additive and nullable — NULL
-- means both dials off, which is what the code already serving does (D-178).

ALTER TABLE "teachers" ADD COLUMN "caption_timing" JSONB;

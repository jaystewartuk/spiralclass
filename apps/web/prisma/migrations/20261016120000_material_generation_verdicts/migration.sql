-- Material generation verdicts (D-202): each quota row now also records which
-- materials call it was, the output, the refine instruction behind it, and
-- whether a save kept it. Purely additive and nullable — the code already
-- serving writes the bare row and reads straight past the new columns (D-178).

-- CreateEnum
CREATE TYPE "MaterialGenerationKind" AS ENUM ('class_content', 'library_material', 'refine', 'podcast_script');

-- AlterTable
ALTER TABLE "class_content_generations" ADD COLUMN     "body" TEXT,
ADD COLUMN     "instruction" TEXT,
ADD COLUMN     "kept_at" TIMESTAMPTZ,
ADD COLUMN     "kind" "MaterialGenerationKind",
ADD COLUMN     "material_id" UUID;

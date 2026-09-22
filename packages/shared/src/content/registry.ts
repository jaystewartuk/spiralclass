import type { ContentAudience, ContentDoc } from "./types";
import { GENERATED_HELP_DOCS } from "./generated";

// Sourced entirely from docs/help/{teacher,student}/*.md — see
// scripts/generate-help-content.mjs. No docs/help/admin/ exists yet, so the
// "admin" audience is a supported case with zero docs, not deleted plumbing.
export const CONTENT_DOCS: readonly ContentDoc[] = GENERATED_HELP_DOCS;

export function getContentDoc(audience: ContentAudience, slug: string): ContentDoc | undefined {
  return CONTENT_DOCS.find((doc) => doc.audience === audience && doc.slug === slug);
}

export function listContentDocs(audience: ContentAudience): ContentDoc[] {
  return CONTENT_DOCS.filter((doc) => doc.audience === audience);
}

export function listPublicFaqDocs(): ContentDoc[] {
  return CONTENT_DOCS.filter((doc) => doc.publicFaq);
}

import { permanentRedirect } from "next/navigation";

// The instructions page lives at /b/[slug]/buy/transfer/[ref] since D-113
// generalized the manual rail. This path stays because students hold it in an
// open tab or an emailed link, and a 404 there is a student who sent money and
// then can't find the reference they were told to quote.
//
// A permanent redirect rather than a duplicate render: one page owns the
// instructions, and search engines never see either (both are noindex, and
// the reference is unguessable by design).
export const dynamic = "force-dynamic";

export default async function LegacyWiseInstructionsPage({
  params,
}: {
  params: Promise<{ slug: string; ref: string }>;
}) {
  const { slug, ref } = await params;
  permanentRedirect(`/b/${encodeURIComponent(slug)}/buy/transfer/${encodeURIComponent(ref)}`);
}

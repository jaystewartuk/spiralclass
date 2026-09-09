import { logger } from "@/lib/logger";

const log = logger({ surface: "csp-report" });

// Sink for Content-Security-Policy violation reports (the `report-uri` directive
// in lib/csp.ts). Browsers POST these unauthenticated, as `application/csp-report`
// ({ "csp-report": {...} }) or the Reporting-API `application/reports+json`
// ([{ type, body }]). This route is exempt from the middleware matcher, does no
// auth, and NEVER trusts or acts on the body — it only logs (structured, so the
// report-only→enforce rollout is observable in Vercel logs) and returns 204.
//
// Hardened against abuse: oversized bodies are dropped without parsing.
const MAX_REPORT_BYTES = 16_384;

type ParsedReport = {
  violatedDirective?: unknown;
  blockedURI?: unknown;
  documentURI?: unknown;
  effectiveDirective?: unknown;
};

function extract(parsed: unknown): ParsedReport | null {
  if (!parsed || typeof parsed !== "object") return null;
  // Legacy shape: { "csp-report": { "violated-directive": ..., ... } }.
  const legacy = (parsed as Record<string, unknown>)["csp-report"];
  if (legacy && typeof legacy === "object") {
    const r = legacy as Record<string, unknown>;
    return {
      violatedDirective: r["violated-directive"],
      effectiveDirective: r["effective-directive"],
      blockedURI: r["blocked-uri"],
      documentURI: r["document-uri"],
    };
  }
  // Reporting-API shape: [{ type: "csp-violation", body: { ... } }].
  const first = Array.isArray(parsed) ? parsed[0] : null;
  const body = first && typeof first === "object" ? (first as Record<string, unknown>).body : null;
  if (body && typeof body === "object") {
    const r = body as Record<string, unknown>;
    return {
      violatedDirective: r.effectiveDirective ?? r.violatedDirective,
      effectiveDirective: r.effectiveDirective,
      blockedURI: r.blockedURL ?? r.blockedURI,
      documentURI: r.documentURL ?? r.documentURI,
    };
  }
  return null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    // Drop oversized reports BEFORE buffering the body (security audit L-5):
    // an attacker could otherwise force us to read an arbitrarily large body
    // into memory before the post-read length check. A missing/invalid
    // Content-Length still falls through to the read + hard length cap below.
    const declaredLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REPORT_BYTES) {
      return new Response(null, { status: 204 });
    }
    const raw = await req.text();
    if (raw.length > MAX_REPORT_BYTES) {
      return new Response(null, { status: 204 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 204 });
    }
    const report = extract(parsed);
    if (report) {
      log.warn("csp violation", {
        violatedDirective: String(report.violatedDirective ?? report.effectiveDirective ?? "?"),
        blockedURI: String(report.blockedURI ?? "?"),
        documentURI: String(report.documentURI ?? "?"),
      });
    }
  } catch {
    // A report sink must never throw — swallow and acknowledge.
  }
  return new Response(null, { status: 204 });
}

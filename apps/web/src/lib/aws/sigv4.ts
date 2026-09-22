import { createHash, createHmac } from "node:crypto";

// Minimal AWS Signature V4 *presigner* for S3-compatible stores (we use it for
// Cloudflare R2 — lesson-insights Phase B). No AWS SDK is in the dependency tree
// and the egress bucket isn't reachable through the Supabase storage seam, so
// the Phase B doc's "direct R2 client" fallback is this: a query-string
// presigned URL we can hand to the ASR vendor (GET) or fetch ourselves to delete
// (DELETE). Correctness is pinned by a unit test against AWS's published
// presigned-URL example vector.
//
// Only what S3 presigning needs: host + path are passed in (caller decides
// path-style vs virtual-host), payload is always UNSIGNED-PAYLOAD, the only
// signed header is host.

const ALGORITHM = "AWS4-HMAC-SHA256";

// RFC3986 encoding. encodeURIComponent leaves !*'() unescaped and escapes ~ —
// AWS wants the opposite, so fix those up. `encodeSlash=false` keeps "/" literal
// for canonical URI paths.
function rfc3986(value: string, encodeSlash = true): string {
  let out = encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  out = out.replace(/%7E/g, "~");
  if (!encodeSlash) out = out.replace(/%2F/g, "/");
  return out;
}

const sha256hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

// YYYYMMDDTHHMMSSZ + YYYYMMDD from a Date, in UTC.
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export type PresignS3Options = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string; // R2 uses "auto"
  host: string; // e.g. "<account>.r2.cloudflarestorage.com"
  method: string; // "GET" | "DELETE" | ...
  path: string; // canonical URI, starts with "/"; path-style includes the bucket
  expiresInSeconds: number;
  now: Date;
  // Extra request query params that must be part of the *signed* canonical
  // query (e.g. ListObjectsV2's `list-type=2&prefix=…&delimiter=/`). Merged in
  // alongside the X-Amz-* params, then the whole set is RFC3986-encoded and
  // sorted before signing. Existing callers pass none, so their signatures are
  // unchanged.
  query?: Record<string, string>;
};

// Build a SigV4 query-string presigned URL. The returned URL embeds the
// signature, so the caller just fetches it with the matching method.
export function presignS3Url(opts: PresignS3Options): string {
  const { amzDate, dateStamp } = stamps(opts.now);
  const scope = `${dateStamp}/${opts.region}/s3/aws4_request`;
  const signedHeaders = "host";

  // Canonical query string: the X-Amz-* params, RFC3986-encoded and sorted by
  // key. X-Amz-Signature is appended later and is NOT part of the signed query.
  const query: Record<string, string> = {
    ...opts.query,
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${opts.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(opts.expiresInSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`)
    .join("&");

  const canonicalUri = rfc3986(opts.path, false);
  const canonicalHeaders = `host:${opts.host}\n`;
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, dateStamp), opts.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return `https://${opts.host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

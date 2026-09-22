import { describe, expect, it } from "vitest";
import { presignS3Url } from "@/lib/aws/sigv4";

// Pin the SigV4 presigner against AWS's published query-string example
// (docs: "Authenticating Requests: Using Query Parameters (AWS Signature
// Version 4)"). If this passes, the signing primitive the R2 store relies on is
// correct — important because we can't exercise real R2 in the dev sandbox.
const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  host: "examplebucket.s3.amazonaws.com",
  method: "GET",
  path: "/test.txt",
  expiresInSeconds: 86400,
  now: new Date("2013-05-24T00:00:00Z"),
};

const EXPECTED_SIGNATURE = "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";

describe("presignS3Url", () => {
  it("matches the AWS published presigned-URL signature vector", () => {
    const url = presignS3Url(EXAMPLE);
    expect(url).toContain(`X-Amz-Signature=${EXPECTED_SIGNATURE}`);
  });

  it("includes the required SigV4 query params and host path", () => {
    const url = new URL(presignS3Url(EXAMPLE));
    expect(url.host).toBe("examplebucket.s3.amazonaws.com");
    expect(url.pathname).toBe("/test.txt");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("changes the signature when the method changes (GET vs DELETE)", () => {
    const get = presignS3Url(EXAMPLE);
    const del = presignS3Url({ ...EXAMPLE, method: "DELETE" });
    expect(del).not.toEqual(get);
  });

  it("keeps slashes literal in a path-style key but signs it", () => {
    const url = new URL(
      presignS3Url({ ...EXAMPLE, path: "/bucket/lesson-audio/b1/student-123.ogg" }),
    );
    expect(url.pathname).toBe("/bucket/lesson-audio/b1/student-123.ogg");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  // The optional `query` param lets ListObjectsV2 fold list-type/prefix/etc. into
  // the SIGNED canonical query (superadmin storage browser). Omitting it must
  // leave existing signatures byte-for-byte unchanged (backward compat).
  describe("extra signed query params", () => {
    it("does not change the signature when `query` is omitted vs empty", () => {
      const withUndef = presignS3Url(EXAMPLE);
      const withEmpty = presignS3Url({ ...EXAMPLE, query: {} });
      expect(withEmpty).toEqual(withUndef);
    });

    it("includes extra params in the URL and signs them", () => {
      const url = new URL(
        presignS3Url({
          ...EXAMPLE,
          path: "/examplebucket",
          query: { "list-type": "2", delimiter: "/", prefix: "t1/" },
        }),
      );
      expect(url.searchParams.get("list-type")).toBe("2");
      expect(url.searchParams.get("delimiter")).toBe("/");
      expect(url.searchParams.get("prefix")).toBe("t1/");
      // Adding a query param changes the canonical request → the signature must
      // differ from the same request without it.
      const bare = presignS3Url({ ...EXAMPLE, path: "/examplebucket" });
      expect(url.searchParams.get("X-Amz-Signature")).not.toBe(
        new URL(bare).searchParams.get("X-Amz-Signature"),
      );
    });

    it("changes the signature when an extra param value changes", () => {
      const a = presignS3Url({ ...EXAMPLE, query: { prefix: "a/" } });
      const b = presignS3Url({ ...EXAMPLE, query: { prefix: "b/" } });
      expect(a).not.toEqual(b);
    });
  });
});

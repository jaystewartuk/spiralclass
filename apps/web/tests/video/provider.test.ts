import { beforeEach, describe, expect, it, vi } from "vitest";

// The video transport sits behind getVideoProvider() (D-16). What matters here:
// it returns null unless all three LiveKit vars are set (so callers degrade to a
// friendly message), the room name is namespaced per booking, and the LiveKit
// adapter mints a join grant carrying the ws url + a token with the right grant.
// The provider reads its keys straight from process.env so an availability check
// never trips the full server-env validation.

const addGrant = vi.fn();
const toJwt = vi.fn(async () => "signed.jwt.token");
// `new` on a vi.fn() mock forwards to its implementation since vitest 5, and an
// arrow function is not constructible — so these SDK client stubs are plain
// functions returning the stub object, which `new` then yields.
const AccessToken = vi.fn(function () {
  return { addGrant, toJwt };
});
vi.mock("livekit-server-sdk", () => ({ AccessToken }));

const { getVideoProvider, classCallRoom } = await import("@/lib/video/provider");

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
});

describe("classCallRoom", () => {
  it("namespaces the room by booking id", () => {
    expect(classCallRoom("b1")).toBe("class-b1");
  });
});

describe("getVideoProvider", () => {
  it("is null when LiveKit isn't fully configured", () => {
    expect(getVideoProvider()).toBeNull();
    process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
    process.env.LIVEKIT_API_KEY = "key";
    // secret still missing → still null
    expect(getVideoProvider()).toBeNull();
  });

  it("mints a join grant with a room-scoped publish/subscribe token", async () => {
    process.env.LIVEKIT_URL = "wss://example.livekit.cloud";
    process.env.LIVEKIT_API_KEY = "key";
    process.env.LIVEKIT_API_SECRET = "secret";

    const provider = getVideoProvider();
    expect(provider).not.toBeNull();

    const grant = await provider!.mintToken({
      room: "class-b1",
      identity: "t1",
      name: "Mira",
    });

    expect(grant).toEqual({ url: "wss://example.livekit.cloud", token: "signed.jwt.token" });
    expect(AccessToken).toHaveBeenCalledWith(
      "key",
      "secret",
      expect.objectContaining({ identity: "t1", name: "Mira" }),
    );
    expect(addGrant).toHaveBeenCalledWith({
      roomJoin: true,
      room: "class-b1",
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });
  });
});

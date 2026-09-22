import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "@/lib/storage/provider";
import { purgeExpiredMaterials } from "@/lib/storage/materials-purge";

const NOW = new Date("2026-04-26T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const OVER_A_YEAR_AGO = new Date(NOW.getTime() - 366 * DAY_MS);
const UNDER_A_YEAR_AGO = new Date(NOW.getTime() - 364 * DAY_MS);

type MaterialRow = {
  id: string;
  storagePath: string | null;
  linkUrl: string | null;
  scheduledEnd: Date;
};

type FakeState = {
  materials: MaterialRow[];
  removed: string[][];
  removedErrors: Map<string, string>;
};

function fakePrisma(state: FakeState) {
  return {
    libraryMaterial: {
      findMany: vi.fn(async ({ where, select }: any) => {
        const cutoff: Date = where.booking.scheduledEnd.lt;
        const filtered = state.materials.filter((m) => {
          if (m.scheduledEnd >= cutoff) return false;
          return Boolean(m.storagePath);
        });
        return filtered.map((m) =>
          select ? Object.fromEntries(Object.keys(select).map((k) => [k, (m as any)[k]])) : m,
        );
      }),
      delete: vi.fn(async ({ where }: any) => {
        const before = state.materials.length;
        state.materials = state.materials.filter((m) => m.id !== where.id);
        if (state.materials.length === before) {
          throw new Error(`material ${where.id} not found`);
        }
      }),
    },
  } as any;
}

function fakeStorage(state: FakeState): StorageProvider {
  return {
    upload: vi.fn(),
    createSignedUrl: vi.fn(),
    publicUrl: vi.fn(),
    ensureBucket: vi.fn(),
    remove: vi.fn(async (bucket: string, paths: string[]) => {
      expect(bucket).toBe("class-materials");
      state.removed.push(paths);
      const failPath = paths.find((p) => state.removedErrors.has(p));
      if (failPath) {
        return { error: { message: state.removedErrors.get(failPath)! } };
      }
      return { error: null };
    }),
  } as unknown as StorageProvider;
}

describe("purgeExpiredMaterials", () => {
  let state: FakeState;

  beforeEach(() => {
    state = {
      materials: [],
      removed: [],
      removedErrors: new Map(),
    };
  });

  it("deletes file-backed materials older than a year + their Storage object", async () => {
    state.materials = [
      {
        id: "old-file",
        storagePath: "t/b/old.pdf",
        linkUrl: null,
        scheduledEnd: OVER_A_YEAR_AGO,
      },
    ];

    const outcome = await purgeExpiredMaterials({
      prisma: fakePrisma(state),
      storage: fakeStorage(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({
      scanned: 1,
      rowsDeleted: 1,
      storageDeleted: 1,
      storageErrors: 0,
    });
    expect(state.removed).toEqual([["t/b/old.pdf"]]);
    expect(state.materials).toHaveLength(0);
  });

  it("leaves recent materials untouched (under a year)", async () => {
    state.materials = [
      {
        id: "recent",
        storagePath: "t/b/recent.pdf",
        linkUrl: null,
        scheduledEnd: UNDER_A_YEAR_AGO,
      },
    ];

    const outcome = await purgeExpiredMaterials({
      prisma: fakePrisma(state),
      storage: fakeStorage(state),
      now: () => NOW,
    });

    expect(outcome.scanned).toBe(0);
    expect(state.materials).toHaveLength(1);
    expect(state.removed).toHaveLength(0);
  });

  it("leaves URL-only attachments untouched (no storagePath)", async () => {
    state.materials = [
      {
        id: "link-only",
        storagePath: null,
        linkUrl: "https://drive/external",
        scheduledEnd: OVER_A_YEAR_AGO,
      },
    ];

    const outcome = await purgeExpiredMaterials({
      prisma: fakePrisma(state),
      storage: fakeStorage(state),
      now: () => NOW,
    });

    expect(outcome).toMatchObject({ scanned: 0, rowsDeleted: 0 });
    expect(state.materials).toHaveLength(1);
  });

  it("counts a Storage delete error and still drops the row (forward progress)", async () => {
    state.materials = [
      {
        id: "stuck",
        storagePath: "t/b/stuck.pdf",
        linkUrl: null,
        scheduledEnd: OVER_A_YEAR_AGO,
      },
    ];
    state.removedErrors.set("t/b/stuck.pdf", "object not found");

    const outcome = await purgeExpiredMaterials({
      prisma: fakePrisma(state),
      storage: fakeStorage(state),
      now: () => NOW,
    });

    expect(outcome).toEqual({
      scanned: 1,
      rowsDeleted: 1,
      storageDeleted: 0,
      storageErrors: 1,
    });
    expect(state.materials).toHaveLength(0);
  });
});

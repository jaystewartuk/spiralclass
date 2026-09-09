import { beforeEach, describe, expect, it, vi } from "vitest";

// This transitively pulls in lib/materials/handlers.ts, which now calls the
// homework auto-draft check (lib/homework/auto-draft.ts) — a server module
// (`import "server-only"`); neutralize the guard, same as homework-wire.test.ts.
vi.mock("server-only", () => ({}));

// Class materials — covers `uploadMaterialAction`'s full
// validation surface:
// - 25 MB file-size cap (class-materials upload)
//   - send_timing enum (confirmation | t_24h | t_1h)
//   - file vs link mutual exclusion + URL parse
// - cross-tenant booking lookup
//   - PostHog `materials_attached` event shape
//   - 'confirmation' timing enqueues an immediate materials_send when
//     the booking is already scheduled

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "55555555-5555-4555-8555-555555555555";

type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  scheduledStart: Date;
  status: string;
};
type MaterialRow = {
  id: string;
  bookingId: string;
  storagePath: string | null;
  linkUrl: string | null;
  label: string | null;
  sendTiming: string;
};

const state: {
  bookings: Map<string, BookingRow>;
  materials: MaterialRow[];
  storageUploads: Array<{ path: string; contentType?: string }>;
  storageUploadShouldFail: boolean;
} = {
  bookings: new Map(),
  materials: [],
  storageUploads: [],
  storageUploadShouldFail: false,
};

const trackEventMock = vi.fn();
const enqueueMaterialsSendMock = vi.fn(async () => "notif-id-1");
const emitNotificationQueuedMock = vi.fn(async () => {});
const revalidatePathMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({
    id: TEACHER_ID,
    timezone: "America/Mexico_City",
  })),
}));

vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackEventMock,
  flushAnalytics: vi.fn(),
}));

vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueMaterialsSend: enqueueMaterialsSendMock,
}));

vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: emitNotificationQueuedMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/storage/provider", () => ({
  getStorageProvider: () => ({
    upload: async (_bucket: string, path: string, _file: File, opts: { contentType?: string }) => {
      state.storageUploads.push({ path, contentType: opts.contentType });
      if (state.storageUploadShouldFail) {
        return { error: { message: "storage 500" } };
      }
      return { error: null };
    },
    remove: vi.fn(async () => ({ error: null })),
    publicUrl: vi.fn(),
    createSignedUrl: vi.fn(),
    ensureBucket: vi.fn(),
  }),
}));

vi.mock("@/lib/prisma", () => {
  function bookingFindFirst({ where }: any) {
    for (const b of state.bookings.values()) {
      if (where.id && b.id !== where.id) continue;
      if (where.teacherId && b.teacherId !== where.teacherId) continue;
      return { ...b };
    }
    return null;
  }
  function libraryMaterialCreate({ data }: any) {
    const row: MaterialRow = {
      id: `material-${state.materials.length + 1}`,
      ...data,
    };
    state.materials.push(row);
    return { id: row.id };
  }
  return {
    prisma: {
      booking: { findFirst: bookingFindFirst },
      libraryMaterial: { create: libraryMaterialCreate },
      // Class-materials scheduling is Pro-only; seed an active subscription so
      // these upload tests exercise the Pro path.
      teacherSubscription: {
        findUnique: async () => ({
          plan: "monthly",
          status: "active",
          comped: false,
          trialEndsAt: null,
          currentPeriodEnd: null,
        }),
      },
    },
  };
});

// D-69 + the materials UI unification: this action now serves both scopes,
// dispatching on whether a bookingId is posted. These tests cover the
// booking-scoped (per-class attachment) path specifically.
const { saveMaterialAttachmentAction: uploadMaterialAction } =
  await import("@/app/actions/library");

function form(entries: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.append(k, v as any);
  }
  return fd;
}

function mkFile(name: string, sizeBytes: number, type = "application/pdf"): File {
  const blob = new Blob([new Uint8Array(sizeBytes)], { type });
  // node's File from blob constructor with size hint
  return new File([blob], name, { type });
}

beforeEach(() => {
  state.bookings.clear();
  state.materials.length = 0;
  state.storageUploads.length = 0;
  state.storageUploadShouldFail = false;
  trackEventMock.mockClear();
  enqueueMaterialsSendMock.mockClear();
  emitNotificationQueuedMock.mockClear();
  revalidatePathMock.mockClear();

  state.bookings.set(BOOKING_ID, {
    id: BOOKING_ID,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    scheduledStart: new Date("2026-05-10T16:00:00.000Z"),
    status: "scheduled",
  });
});

describe("uploadMaterialAction — file path", () => {
  it("rejects files larger than 25 MB (class-materials upload)", async () => {
    const tooBig = mkFile("big.pdf", 25 * 1024 * 1024 + 1);
    const result = await uploadMaterialAction(
      undefined,
      form({ bookingId: BOOKING_ID, sendTiming: "confirmation", file: tooBig }),
    );
    expect(result?.error).toMatch(/25 MB/);
    expect(state.materials).toHaveLength(0);
    expect(state.storageUploads).toHaveLength(0);
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it("accepts a file at the 25 MB boundary, uploads to bucket scoped by teacher_id and booking_id", async () => {
    const exactly = mkFile("ok.pdf", 25 * 1024 * 1024);
    const result = await uploadMaterialAction(
      undefined,
      form({ bookingId: BOOKING_ID, sendTiming: "t_24h", file: exactly, label: "Tarea 1" }),
    );
    expect(result?.ok).toBe(true);
    expect(state.storageUploads).toHaveLength(1);
    expect(state.storageUploads[0].path).toMatch(
      new RegExp(`^${TEACHER_ID}/${BOOKING_ID}/\\d+-ok\\.pdf$`),
    );
    expect(state.materials[0]).toMatchObject({
      bookingId: BOOKING_ID,
      label: "Tarea 1",
      sendTiming: "t_24h",
      storagePath: state.storageUploads[0].path,
      linkUrl: null,
    });
    expect(trackEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "materials_attached",
        properties: expect.objectContaining({
          attachmentKind: "file",
          sendTiming: "t_24h",
        }),
      }),
    );
  });

  it("surfaces the supabase error when storage upload fails", async () => {
    state.storageUploadShouldFail = true;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await uploadMaterialAction(
      undefined,
      form({ bookingId: BOOKING_ID, sendTiming: "t_1h", file: mkFile("a.pdf", 1024) }),
    );
    expect(result?.error).toMatch(/storage 500/);
    expect(state.materials).toHaveLength(0);
    expect(trackEventMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("uploadMaterialAction — link path", () => {
  it("accepts a valid URL and persists it as linkUrl", async () => {
    const result = await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "t_1h",
        linkUrl: "https://docs.google.com/document/d/abc",
      }),
    );
    expect(result?.ok).toBe(true);
    expect(state.materials[0]).toMatchObject({
      linkUrl: "https://docs.google.com/document/d/abc",
      storagePath: null,
      sendTiming: "t_1h",
    });
    expect(state.storageUploads).toHaveLength(0);
    expect(trackEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ attachmentKind: "link" }),
      }),
    );
  });

  it("rejects a malformed URL", async () => {
    const result = await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "t_1h",
        linkUrl: "not a url",
      }),
    );
    expect(result?.error).toMatch(/URL inválida/);
    expect(state.materials).toHaveLength(0);
  });

  it("rejects when neither file nor link is provided", async () => {
    const result = await uploadMaterialAction(
      undefined,
      form({ bookingId: BOOKING_ID, sendTiming: "confirmation" }),
    );
    expect(result?.error).toMatch(/archivo o.*enlace/i);
    expect(state.materials).toHaveLength(0);
  });
});

describe("uploadMaterialAction — guard rails", () => {
  it("rejects an invalid sendTiming enum value", async () => {
    const result = await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "whenever",
        linkUrl: "https://x.com",
      }),
    );
    expect(result?.error).toMatch(/cuándo enviar/i);
    expect(state.materials).toHaveLength(0);
  });

  it("without a bookingId, falls back to library scope and requires a level", async () => {
    // The unified action (docs/features/library-materials.md) dispatches on
    // bookingId presence — a blank one means "library item", which needs a
    // level rather than a booking.
    const result = await uploadMaterialAction(
      undefined,
      form({
        bookingId: "",
        sendTiming: "confirmation",
        linkUrl: "https://x.com",
      }),
    );
    expect(result?.error).toMatch(/nivel/i);
    expect(state.materials).toHaveLength(0);
  });

  it(": refuses cross-tenant booking lookup", async () => {
    state.bookings.get(BOOKING_ID)!.teacherId = OTHER_TEACHER_ID;
    const result = await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "confirmation",
        linkUrl: "https://x.com",
      }),
    );
    expect(result?.error).toMatch(/Clase no encontrada/i);
    expect(state.materials).toHaveLength(0);
    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it("clamps label to 80 chars", async () => {
    const longLabel = "x".repeat(200);
    await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "t_24h",
        linkUrl: "https://x.com/y",
        label: longLabel,
      }),
    );
    expect(state.materials[0].label?.length).toBe(80);
  });
});

describe("uploadMaterialAction — confirmation send-now branch", () => {
  it("enqueues a materials_send + emits the queued event when sendTiming='confirmation' and booking is already scheduled", async () => {
    await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "confirmation",
        linkUrl: "https://x.com/material",
      }),
    );
    expect(enqueueMaterialsSendMock).toHaveBeenCalledTimes(1);
    expect(enqueueMaterialsSendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teacherId: TEACHER_ID,
        studentId: STUDENT_ID,
        bookingId: BOOKING_ID,
        materialsUrl: "https://x.com/material",
      }),
    );
    expect(emitNotificationQueuedMock).toHaveBeenCalledWith({
      notificationId: "notif-id-1",
      teacherId: TEACHER_ID,
    });
  });

  it("does NOT enqueue for a t_24h timing whose send moment is still ahead (rides the reminder leg)", async () => {
    // Class 48h out → the 24h-before send moment hasn't arrived yet.
    state.bookings.get(BOOKING_ID)!.scheduledStart = new Date(Date.now() + 48 * 3600_000);
    await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "t_24h",
        linkUrl: "https://x.com/y",
      }),
    );
    expect(enqueueMaterialsSendMock).not.toHaveBeenCalled();
    expect(emitNotificationQueuedMock).not.toHaveBeenCalled();
  });

  it("enqueues immediately when the chosen timing is already past (t_24h attached 10h before class)", async () => {
    state.bookings.get(BOOKING_ID)!.scheduledStart = new Date(Date.now() + 10 * 3600_000);
    await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "t_24h",
        linkUrl: "https://x.com/late-material",
      }),
    );
    expect(enqueueMaterialsSendMock).toHaveBeenCalledTimes(1);
    expect(emitNotificationQueuedMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT enqueue for sendTiming='confirmation' when booking is not scheduled (e.g., already canceled)", async () => {
    state.bookings.get(BOOKING_ID)!.status = "canceled_by_student";
    await uploadMaterialAction(
      undefined,
      form({
        bookingId: BOOKING_ID,
        sendTiming: "confirmation",
        linkUrl: "https://x.com/material",
      }),
    );
    expect(enqueueMaterialsSendMock).not.toHaveBeenCalled();
  });
});

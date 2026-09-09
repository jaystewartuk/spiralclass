import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";
import { parseMaterialsFilter, parseMaterialsGroupBy } from "@/lib/materials/student-materials";

(globalThis as Record<string, unknown>).React = React;

// Regression coverage for the materials-history section on the teacher-facing
// student detail page. It unions the three routes a material takes into a
// class (see lib/materials/class-history.ts) — the class's own material, a
// library item attached to it, and a material opened during the call — with an
// All/Used/Sent filter and a class/date/type grouping toggle, both driven by
// URL search params (?mf=&mg=), same pattern as the calendar view switcher.
//
// It renders the Materials PANEL rather than the whole page: the screen is five
// URL-addressed views now, and going through the page would mean re-stubbing
// four unrelated panels to assert one. The parameters this file is about are
// still the same two, still parsed from the URL — see
// tests/students/student-detail-shell.test.ts for the routing itself.

const TEACHER = { id: "t1", timezone: "America/Mexico_City" };

vi.mock("@/app/actions/library", () => ({
  setLibraryItemCompletedAction: async () => {},
  unassignLibraryMaterialAction: async () => {},
}));

// Two classes: an older one (fully in the past, so its material has elapsed)
// and a near-future one whose t_1h material has NOT elapsed yet.
const pastBooking = { id: "b-past", scheduledStart: new Date(Date.now() - 30 * 24 * 3600_000) };
const futureBooking = { id: "b-future", scheduledStart: new Date(Date.now() + 30 * 24 * 3600_000) };

const rawMaterials = [
  {
    id: "m-past",
    label: "Vocabulario",
    storagePath: null,
    linkUrl: "https://example.com/vocab",
    body: null,
    sendTiming: "t_24h",
    createdAt: new Date(Date.now() - 30 * 24 * 3600_000),
    booking: pastBooking,
  },
  {
    id: "m-future",
    label: "Tarea",
    storagePath: null,
    linkUrl: "https://example.com/homework",
    body: null,
    sendTiming: "t_1h",
    createdAt: new Date(),
    booking: futureBooking,
  },
];

// A reusable library item attached to the past class. Before the history
// unioned its three sources this was invisible on this page entirely.
let attachedRows: unknown[] = [];
// A material the teacher opened ON the call. A library item opened mid-lesson
// and never attached exists in no other table.
let usedRows: unknown[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // Two distinct queries share this model (D-69): the plain reusable library
    // list (bookingId absent from the where clause) and the cross-booking
    // scheduled-materials rollup (bookingId: { not: null }).
    libraryMaterial: {
      findMany: async ({ where }: any) => (where?.bookingId ? rawMaterials : []),
    },
    bookingLibraryMaterial: { findMany: async () => attachedRows },
    classMaterialUse: { findMany: async () => usedRows },
    studentLibraryItem: { findMany: async () => [] },
  },
}));

vi.mock("@/lib/levels", () => ({ getTeacherLevels: async () => [] }));

vi.mock("@/app/(app)/dashboard/students/[studentId]/assign-material-form", () => ({
  AssignMaterialForm: () => null,
}));

const { MaterialsTab } = await import("@/app/(app)/dashboard/students/[studentId]/tab-materials");

/**
 * The one list row a title appears in.
 *
 * The assertions used to slice a fixed 400 or 500 characters after the title,
 * which is a window that silently stops covering the row the moment anything
 * is added to it — an inline "opens externally" icon was enough to push the
 * status badge out of frame and fail two tests that were about the badge, not
 * about the icon. Bounded by the row's own markup instead.
 */
function rowFor(html: string, title: string): string {
  const at = html.indexOf(title);
  if (at === -1) return "";
  const open = html.lastIndexOf("<li", at);
  const close = html.indexOf("</li>", at);
  return html.slice(open, close === -1 ? undefined : close);
}

async function html(sp: { mf?: string; mg?: string } = {}): Promise<string> {
  const el = await MaterialsTab({
    studentId: "s1",
    teacher: TEACHER as never,
    locale: "es-MX",
    t: createT("es-MX"),
    filter: parseMaterialsFilter(sp.mf),
    groupBy: parseMaterialsGroupBy(sp.mg),
  });
  return renderToStaticMarkup(el);
}

describe("teacher student detail — Materials panel, class materials rollup", () => {
  beforeEach(() => {
    attachedRows = [];
    usedRows = [];
  });

  it("renders the section with both materials by default (all, grouped by class)", async () => {
    const out = await html();
    expect(out).toContain("Vocabulario");
    expect(out).toContain("Tarea");
    // Two distinct classes → two group headings.
    //
    // Counted by a data attribute, not by a CSS class. This used to match
    // `uppercase tracking-wide`, which broke the moment D-140's "no all-caps
    // labels" rule was actually applied — the styling was load-bearing for the
    // test but not for the product, so a correct design change failed a test
    // that was not about design.
    expect(out.match(/data-class-material-group/g)?.length).toBe(2);
  });

  it("marks the past material as sent and the future one as pending", async () => {
    const out = await html();
    expect(rowFor(out, "Vocabulario")).toContain("Enviado");
    expect(rowFor(out, "Tarea")).toContain("Pendiente");
  });

  it("'sent only' filter (?mf=sent) drops the not-yet-sent material", async () => {
    const out = await html({ mf: "sent" });
    expect(out).toContain("Vocabulario");
    expect(out).not.toContain("Tarea");
  });

  it("'by type' grouping (?mg=type) collapses both link materials into one group", async () => {
    const out = await html({ mg: "type" });
    expect(out).toContain("Vocabulario");
    expect(out).toContain("Tarea");
    expect(out.match(/data-class-material-group/g)?.length).toBe(1);
    expect(out).toContain("Enlaces");
  });

  // The three routes a material takes into a class. Each of the two below was
  // invisible on this page before the history unioned its sources.
  it("includes a reusable library item attached to one of the classes", async () => {
    attachedRows = [
      {
        sendTiming: "confirmation",
        attachedAt: new Date(Date.now() - 30 * 24 * 3600_000),
        booking: pastBooking,
        material: {
          id: "m-lib",
          label: "Hoja de subjuntivo",
          storagePath: null,
          linkUrl: "https://example.com/lib",
          body: null,
          bookingId: null,
        },
      },
    ];
    const out = await html();
    expect(out).toContain("Hoja de subjuntivo");
    expect(out).toContain("De tu biblioteca");
  });

  it("includes a library material opened on the call but never attached", async () => {
    usedRows = [
      {
        openedAt: new Date(Date.now() - 30 * 24 * 3600_000),
        booking: pastBooking,
        material: {
          id: "m-opened",
          label: "Diálogo en el mercado",
          storagePath: null,
          linkUrl: "https://example.com/opened",
          body: null,
          bookingId: null,
          sendTiming: null,
        },
      },
    ];
    const out = await html();
    expect(out).toContain("Diálogo en el mercado");
    const row = rowFor(out, "Diálogo en el mercado");
    expect(row).toContain("Usado en clase");
    // Never attached, so the student cannot see it however old the class is.
    expect(row).toContain("Pendiente");
  });

  // "Prepared" and "used" are different facts: the filter must not conflate
  // them, which is the distinction the whole section exists to show.
  it("'used in class' filter (?mf=used) keeps only what was opened on a call", async () => {
    usedRows = [
      {
        openedAt: new Date(Date.now() - 30 * 24 * 3600_000),
        booking: pastBooking,
        material: {
          id: "m-opened",
          label: "Diálogo en el mercado",
          storagePath: null,
          linkUrl: "https://example.com/opened",
          body: null,
          bookingId: null,
          sendTiming: null,
        },
      },
    ];
    const out = await html({ mf: "used" });
    expect(out).toContain("Diálogo en el mercado");
    expect(out).not.toContain("Vocabulario");
    expect(out).not.toContain("Tarea");
  });

  // A class's own lesson content carries no label by design, so it needs the
  // body's first heading to be identifiable in a list.
  it("titles a class's unlabelled lesson content from its first heading", async () => {
    usedRows = [
      {
        openedAt: pastBooking.scheduledStart,
        booking: pastBooking,
        material: {
          id: "m-content",
          label: null,
          storagePath: null,
          linkUrl: null,
          body: "## Pretérito vs imperfecto\n\nEjercicios...",
          bookingId: "b-past",
          sendTiming: null,
        },
      },
    ];
    const out = await html();
    expect(out).toContain("Pretérito vs imperfecto");
  });
});

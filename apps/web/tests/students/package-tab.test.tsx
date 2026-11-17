import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createT } from "@spiralclass/shared";

(globalThis as Record<string, unknown>).React = React;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      groupBy: async ({ where }: { where: { countsAgainstPackage?: boolean } }) =>
        where.countsAgainstPackage ? [] : [{ packageId: "cancelled-history", _count: { _all: 1 } }],
    },
    payment: { groupBy: async () => [{ packageId: "paid", _count: { _all: 1 } }] },
    packageTemplate: { findMany: async () => [] },
    teacherStudentTemplatePrice: { findMany: async () => [] },
    override: { findMany: async () => [] },
  },
}));
vi.mock("@/components/locale-provider", () => ({ useT: () => createT("en") }));
vi.mock("@/components/packages/package-details-sheet", () => ({
  PackageDetailsSheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/add-package-form", () => ({
  AddPackageForm: () => null,
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/edit-package-form", () => ({
  EditPackageForm: () => null,
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/custom-price-form", () => ({
  CustomPriceForm: () => null,
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/package-pause-button", () => ({
  PackagePauseButton: () => null,
}));
vi.mock("@/app/actions/teacher-packages", () => ({ deleteManualPackageAction: vi.fn() }));

const { PackagesTab } = await import("@/app/(app)/dashboard/students/[studentId]/tab-packages");
type Props = React.ComponentProps<typeof PackagesTab>;

async function renderPackage(id: string, classesUsed = 0, scheduled = 0) {
  return renderToStaticMarkup(
    await PackagesTab({
      studentId: "student-1",
      teacher: { id: "teacher-1", timezone: "UTC", pricingCurrency: "GBP" } as Props["teacher"],
      locale: "en",
      t: createT("en"),
      packages: [
        {
          id,
          template: null,
          classesTotal: 10,
          classesUsed,
          classDurationMin: 50,
          pricePaidMinorUnits: 10000,
          currency: "GBP",
          status: "active",
          expiresAt: null,
          seats: 1,
        } as Props["packages"][number],
      ],
      scheduledByPackage: new Map([[id, scheduled]]),
    }),
  );
}

describe("student package rows", () => {
  it.each([
    ["fresh", 0, 0, 10],
    ["used", 10, 0, 0],
    ["scheduled", 4, 4, 10],
  ] as const)(
    "shows the classes still owed for %s and offers Delete without history",
    async (id, used, scheduled, owed) => {
      const html = await renderPackage(id, used, scheduled);
      expect(html).toContain(`tabular-nums">${owed}</span>`);
      expect(html).toContain(">Delete</button>");
      expect(html).not.toContain('disabled=""');
    },
  );

  it.each([
    ["cancelled-history", "hasBookings"],
    ["paid", "hasPayment"],
  ] as const)("keeps Delete visible with the correct reason for %s", async (id, key) => {
    const html = await renderPackage(id);
    expect(html).toContain('disabled=""');
    expect(html).toContain(">Delete</button>");
    expect(html).toContain(createT("en")(`web.action.teacherPackages.${key}`));
  });
});

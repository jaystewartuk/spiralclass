import { revalidatePath } from "next/cache";

// A class's "Has Materials" chip is rendered on the class *lists* — the teacher
// dashboard list (/dashboard/classes) and the student list (/my-classes) — not
// only on the class-detail page. Any mutation that changes whether a class has
// at least one material (of EITHER kind — a library-linked attachment or a
// class-scoped/private material) must revalidate both lists, or the chip stays
// stale until a manual refresh. Callers still revalidate the class-detail page
// (and /dashboard/materials for the library) separately; this only covers the
// two list surfaces the chip also lives on.
export function revalidateClassMaterialLists(): void {
  revalidatePath("/dashboard/classes");
  revalidatePath("/my-classes");
}

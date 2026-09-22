import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getT } from "@/lib/i18n";

// The four surfaces of "Get students", as navigation.
//
// They used to be three ghost buttons in the hub's header and a single "Get
// students" back button on each of the other three — so the feature had no
// navigation at all, only a way out. Which meant Communities and Results were
// two hops apart through a page neither of them is about.
//
// One row on all four screens, with the current one marked. A `<nav>` with a
// name because a screen-reader user lands on a landmark list, and `aria-current`
// because "which of these am I on" must not be carried by the fill alone.
const SECTIONS = [
  { key: "plan", href: "/dashboard/get-students", label: "web.getStudents.planTab" },
  {
    key: "communities",
    href: "/dashboard/get-students/communities",
    label: "web.getStudents.communities",
  },
  { key: "results", href: "/dashboard/get-students/results", label: "web.getStudents.results" },
  {
    key: "profile",
    href: "/dashboard/get-students/profile",
    label: "web.getStudents.marketingProfile",
  },
] as const;

export type GetStudentsSection = (typeof SECTIONS)[number]["key"];

export async function SectionNav({ current }: { current: GetStudentsSection }) {
  const t = await getT();
  return (
    <nav aria-label={t("web.getStudents.sectionsNav")}>
      <ul className="flex flex-wrap items-center gap-1">
        {SECTIONS.map((section) => {
          const active = section.key === current;
          return (
            <li key={section.key}>
              <Button asChild variant={active ? "secondary" : "ghost"} size="sm">
                <Link href={section.href} aria-current={active ? "page" : undefined}>
                  {t(section.label)}
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

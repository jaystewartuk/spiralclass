import { headers } from "next/headers";
import { currencyForTeacher } from "@spiralclass/shared";
import { AppNav } from "./app-nav";
import { LanguagePicker } from "@/components/language-picker";
import { PostHogIdentify } from "@/components/posthog-identify";
import { PricingCurrencyProvider } from "@/components/pricing-currency-context";
import { TABLET_SIDEBAR_CONTENT_OFFSET_CLASS } from "@/components/tablet-sidebar-nav";
import { requireTeacher } from "@/lib/auth";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { getTeacherInboxUnreadCount } from "@/lib/notifications/inbox-queries";
import { SubscriptionBanner } from "./subscription-banner";

// Persistent shell for the teacher app: a sticky header with primary
// navigation so teachers can move between Panel / Clases / Alumnos / Pagos /
// Configuración without going home first (audit IA-1). The nav hides itself
// on the onboarding flow, which keeps its own focused stepper layout.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Resolve (and lazily provision) the teacher here in the parent layout so
  // the row — and the server-side identify — exist before any child page
  // renders. Reading via getCurrentTeacher() instead raced row creation in the
  // page: a brand-new teacher's first session rendered the layout with no
  // teacher, so <PostHogIdentify> never mounted, and because soft navigations
  // don't re-render the layout the client identify never fired all session —
  // splitting the teacher across an anonymous Person and the identified one.
  const teacher = await requireTeacher();

  const unreadCount = await getTeacherInboxUnreadCount(teacher.id);
  // Onboarding has its own focused stepper layout — no app chrome there. Same
  // guard AppNav uses, but the banner is a Server Component (no usePathname),
  // so it reads the pathname middleware forwards via the x-pathname header.
  const pathname = (await headers()).get("x-pathname") ?? "";
  const onOnboarding = pathname.startsWith("/onboarding");
  return (
    // Her pricing currency is published to the whole teacher shell here: it is
    // one immutable value that six client money-forms need, both to label a
    // field and — more importantly — to convert major units to minor ones
    // without falling back to `majorToMinorUnits`'s MXN default.
    <PricingCurrencyProvider currency={currencyForTeacher(teacher)}>
      <PostHogIdentify
        distinctId={teacher.id}
        email={teacher.email}
        name={teacher.name}
        role="teacher"
        teacherId={teacher.id}
      />
      <AppNav
        localeToggle={<LanguagePicker variant="field" />}
        account={{
          name: teacher.name,
          email: teacher.email,
          role: "teacher",
          // Version-stamped (updatedAt) so a re-upload busts the CDN copy in
          // the header; null when the teacher hasn't uploaded a photo.
          photoUrl: teacherPhotoPublicUrl(teacher.photoPath, teacher.updatedAt.getTime()),
        }}
        bookingSlug={teacher.bookingSlug}
        unreadCount={unreadCount}
      />
      {/* The tablet sidebar (AppNav) is fixed-positioned beside this content,
        not in normal flow, so its width has to be reserved here explicitly —
        onOnboarding never renders that sidebar (AppNav returns null there),
        so it never reserves space for it either. */}
      <div className={onOnboarding ? undefined : TABLET_SIDEBAR_CONTENT_OFFSET_CLASS}>
        {!onOnboarding && <SubscriptionBanner teacherId={teacher.id} />}
        {children}
      </div>
    </PricingCurrencyProvider>
  );
}

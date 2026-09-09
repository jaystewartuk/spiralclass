export type SectionNavItem = { id: string; label: string };

/**
 * Jump links to the sections below.
 *
 * This screen is long — the intro-video card alone can be a full viewport with
 * the recorder and coach panel open — and most visits to it are errands: change
 * the WhatsApp number, swap the photo. Without this, every errand starts with a
 * scroll-hunt.
 *
 * Not sticky, on purpose: the app's own nav already owns `top-0`, and a second
 * sticky bar under it would eat a third of a phone viewport to save a scroll
 * that is only needed once, from the top, which is exactly where this sits.
 */
export function SectionNav({ label, items }: { label: string; items: SectionNavItem[] }) {
  return (
    <nav aria-label={label} className="-mx-1 overflow-x-auto pb-1">
      <ul className="flex w-max gap-1.5 px-1">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="flex h-11 items-center whitespace-nowrap rounded-full border border-border bg-card px-3.5 text-sm text-muted-foreground ring-offset-background transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

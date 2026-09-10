import type { Metadata } from "next";
import { palette, paletteDark } from "@spiralclass/shared";
import { WCAG, contrastRatio } from "@/lib/contrast";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { Panel } from "@/components/ui/panel";
import { LogoMark } from "@/components/brand/logo";

/**
 * The design system, rendered from the system itself.
 *
 * Every swatch below reads its value from packages/shared/src/tokens.ts and
 * every component is the real component, so this page cannot describe a system
 * the product does not have. A hand-written style guide can, and always
 * eventually does.
 *
 * It is also the fastest drift detector there is: a token that breaks shows up
 * here in one screen instead of across 98 routes.
 *
 * Not indexed — it is for whoever is building or evaluating the product, not
 * for search. See robots.ts and the sitemap's own exclusion.
 */
export const metadata: Metadata = {
  title: "Design system",
  robots: { index: false, follow: false },
};

const SURFACES = ["background", "surface", "muted", "secondary"] as const;

function Swatch({ name, hex }: { name: string; hex: string }) {
  return (
    <div className="border-border overflow-hidden rounded-md border">
      <div className="h-14 w-full" style={{ background: hex }} />
      <div className="flex flex-col gap-0.5 p-2">
        <span className="text-sm font-bold">{name}</span>
        <span className="text-muted-foreground font-mono text-xs">{hex}</span>
      </div>
    </div>
  );
}

/** The contrast matrix, computed rather than claimed. */
function ContrastRow({
  fg,
  bg,
  min,
  theme,
}: {
  fg: keyof typeof palette;
  bg: keyof typeof palette;
  min: number;
  theme: typeof palette;
}) {
  const ratio = contrastRatio(theme[fg], theme[bg]);
  const passes = ratio >= min;
  return (
    <tr>
      <td className="font-mono text-xs">
        {fg} on {bg}
      </td>
      <td className="text-right font-mono text-xs tabular-nums">{ratio.toFixed(2)}</td>
      <td className="text-right font-mono text-xs tabular-nums">{min}</td>
      <td className="text-right">
        <Badge variant={passes ? "success" : "destructive"}>{passes ? "pass" : "fail"}</Badge>
      </td>
    </tr>
  );
}

export default function DesignSystemPage() {
  return (
    <PageShell width="wide">
      <PageHeader
        title="Design system"
        description="Rendered from the tokens, not written about them. Every swatch reads its value from packages/shared, and every component below is the one the product ships."
      />

      <Panel
        title="The mark"
        description="One geometry, simplified below 48px where the inner coil fills in."
      >
        <div className="flex flex-wrap items-end gap-8">
          {[24, 32, 48, 64, 96].map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <LogoMark size={size} />
              <span className="text-muted-foreground font-mono text-xs">{size}px</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Surfaces"
        description="Four grounds. Anything that sits on one must clear its contrast against the hardest of them."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SURFACES.map((name) => (
            <Swatch key={name} name={name} hex={palette[name]} />
          ))}
        </div>
      </Panel>

      <Panel title="Roles" description="Named by the job they do, not by the colour they are.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {(
            [
              "text",
              "textMuted",
              "borderStrong",
              "primary",
              "accent",
              "success",
              "warning",
              "danger",
              "info",
              "clay",
              "sage",
            ] as const
          ).map((name) => (
            <Swatch key={name} name={name} hex={palette[name]} />
          ))}
        </div>
      </Panel>

      <Panel
        title="Contrast"
        description="Computed on render. A failure here is a failure in the product, not a stale note in a document."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-muted-foreground text-xs font-bold">
                <th className="py-1">Pairing</th>
                <th className="py-1 text-right">Ratio</th>
                <th className="py-1 text-right">Needs</th>
                <th className="py-1 text-right">Light</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["text", "background", WCAG.AAA],
                  ["textMuted", "surface", WCAG.AA],
                  ["primaryText", "primary", WCAG.AA],
                  ["accentText", "accent", WCAG.AA],
                  ["dangerText", "danger", WCAG.AA],
                  ["success", "successBg", WCAG.AA],
                  ["borderStrong", "background", WCAG.AA_LARGE],
                ] as const
              ).map(([fg, bg, min]) => (
                <ContrastRow key={`${fg}-${bg}`} fg={fg} bg={bg} min={min} theme={palette} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-muted-foreground text-sm">
          The dark theme is solved independently and asserted by
          <span className="font-mono"> src/lib/palette-contrast.test.ts</span>, which also requires
          body text to stay <em>under</em> 16:1 — black on white is 21:1 and is the pairing most
          often reported as causing glare.
        </p>
      </Panel>

      <Panel title="Buttons" description="Every variant, at the standing 44px minimum target.">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Panel>

      <Panel
        title="Status"
        description="Never carried by hue alone — every state has a word in it."
      >
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              "default",
              "secondary",
              "outline",
              "success",
              "warning",
              "info",
              "clay",
              "sage",
              "destructive",
            ] as const
          ).map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
        </div>
      </Panel>

      <Panel title="Alerts">
        <div className="flex flex-col gap-3">
          {(["default", "success", "warning", "info", "destructive"] as const).map((variant) => (
            <Alert key={variant} variant={variant}>
              A {variant} alert, with its own foreground solved against its ground.
            </Alert>
          ))}
        </div>
      </Panel>

      <Panel title="Fields" description="2px border at 3:1, 3px focus ring. Tab into it.">
        <div className="flex max-w-sm flex-col gap-2">
          <Input placeholder="Email address" />
          <Input placeholder="Disabled" disabled />
        </div>
      </Panel>

      <Panel title="Empty state">
        <EmptyState
          title="Nothing here yet"
          description="What a list says before it has anything to show."
        />
      </Panel>

      <Panel title="Cards">
        <Card>
          <CardHeader>
            <CardTitle>A card</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              A raised object among objects. A Panel — what every section on this page uses — is a
              region of the screen you are already on.
            </p>
          </CardContent>
        </Card>
      </Panel>

      <Panel title="Dark" description="Solved independently. Not an inversion of the light theme.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SURFACES.map((name) => (
            <Swatch key={name} name={name} hex={paletteDark[name]} />
          ))}
        </div>
      </Panel>
    </PageShell>
  );
}

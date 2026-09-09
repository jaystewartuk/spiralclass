// Shared shell for the settings pages. The sub-navigation bar that used to
// live here was superseded by the main navbar's "Tu página" / "Contenido" /
// account dropdowns and removed.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <main className="container space-y-6 py-8 lg:max-w-3xl lg:py-10">{children}</main>;
}

// Renders a schema.org JSON-LD block. A <script type="application/ld+json">
// is a data block, not an executable script, so the nonce-based CSP does not
// apply to it. `<` is escaped so user-authored content (teacher bios) can
// never break out of the script element with a literal "</script>".
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data).replace(/</g, "\\u003c"),
      }}
    />
  );
}

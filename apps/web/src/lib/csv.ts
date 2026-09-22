// Tiny CSV serializer for admin exports. Not RFC-4180-strict — escapes
// only the cells that need it (commas, quotes, newlines). Excel-friendly
// (CRLF line endings; quoted fields when needed).
//
// Use for finance reconciliation exports. NOT for streaming gigabytes —
// each call builds the full string in memory. Today's volumes are well
// under 10k rows so this is fine; the /api/admin/export routes cap at
// the same PAGE_SIZE the admin pages use.

const NEEDS_QUOTE = /[",\r\n]/;
// A cell whose text starts with one of these is interpreted as a FORMULA by
// Excel / Google Sheets / LibreOffice when the file is opened. Our exports
// carry user-controlled strings (teacher/student names + emails, typed freely
// at signup and public checkout), so `=HYPERLINK(...)`, `=cmd|...`, `+`/`-`/`@`
// formulas, etc. would execute on the finance operator's machine. Neutralize
// by prefixing a single quote so the cell is treated as literal text.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let str = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_TRIGGER.test(str)) {
    str = `'${str}`;
  }
  if (NEEDS_QUOTE.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const headerLine = headers.map(escapeCell).join(",");
  const bodyLines = rows.map((r) => r.map(escapeCell).join(","));
  return [headerLine, ...bodyLines].join("\r\n");
}

export function csvResponse(filenameStem: string, body: string): Response {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filenameStem}-${stamp}.csv"`,
    },
  });
}

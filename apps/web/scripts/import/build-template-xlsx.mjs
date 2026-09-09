// Builds the human-entry .xlsx template that mirrors the importer's CSV
// contract (see ./README.md). Run: `node scripts/import/build-template-xlsx.mjs`
// Output: ./SpiralClass-importacion.xlsx
//
// No xlsx dependency — an .xlsx is a ZIP of OOXML parts, written here with
// Node built-ins only. Every data cell is TEXT-formatted on purpose so that
// phone numbers (+52…), dates (YYYY-MM-DD) and datetimes survive a
// download-as-CSV without Excel/Sheets silently reformatting them, which would
// break the importer's strict regex validation.

import { deflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "SpiralClass-importacion.xlsx");

// --- XML helpers ---
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const colLetter = (i) => {
  let s = "";
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};

// Build one worksheet. `rows` is a 2D array of strings (row 0 = header).
// opts: { cols: number[] widths, textCols: bool, validation: {col,values}[] }
function sheetXml(rows, opts = {}) {
  const { widths = [], headerStyle = 1, dataStyle = 2, validations = [] } = opts;

  const colsXml = widths.length
    ? `<cols>${widths
        .map(
          (w, i) =>
            `<col min="${i + 1}" max="${i + 1}" width="${w}" style="${dataStyle}" customWidth="1"/>`,
        )
        .join("")}</cols>`
    : "";

  const rowsXml = rows
    .map((cells, r) => {
      const style = r === 0 ? headerStyle : dataStyle;
      const cellsXml = cells
        .map((val, c) => {
          if (val === "" || val == null) return "";
          const ref = `${colLetter(c)}${r + 1}`;
          return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cellsXml}</row>`;
    })
    .join("");

  const dvXml = validations.length
    ? `<dataValidations count="${validations.length}">${validations
        .map(
          (v) =>
            `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${colLetter(v.col)}2:${colLetter(v.col)}1000"><formula1>&quot;${v.values.join(",")}&quot;</formula1></dataValidation>`,
        )
        .join("")}</dataValidations>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr/><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${rowsXml}</sheetData>${dvXml}</worksheet>`;
}

// --- Sheet content ---

const students = [
  ["student_ref", "name", "email", "phone", "timezone", "locale"],
  [
    "maria-h",
    "María Hernández",
    "maria@example.com",
    "+5215555000001",
    "America/Mexico_City",
    "es-MX",
  ],
  ["carlos-r", "Carlos Ruiz", "", "+5215555000002", "America/Mexico_City", "es-MX"],
];

const packages = [
  [
    "package_ref",
    "student_ref",
    "classes_total",
    "classes_used",
    "price_paid_mxn",
    "purchased_date",
    "expires_date",
    "status",
  ],
  ["maria-h-p1", "maria-h", "20", "3", "5500", "2026-05-01", "2026-09-01", "active"],
  ["carlos-r-p1", "carlos-r", "8", "2", "2400", "2026-05-20", "2026-06-20", "active"],
];

const bookings = [
  ["student_ref", "package_ref", "start_datetime", "duration_min", "status"],
  ["maria-h", "maria-h-p1", "2026-06-04 10:00", "50", "scheduled"],
  ["maria-h", "maria-h-p1", "2026-06-11 10:00", "50", "scheduled"],
  ["carlos-r", "carlos-r-p1", "2026-05-28 17:00", "50", "completed"],
  ["carlos-r", "carlos-r-p1", "2026-06-05 17:00", "50", "scheduled"],
];

// Instrucciones tab (Spanish — the reader who needs guidance). Each entry is
// one row in column A.
const instrucciones = [
  ["SpiralClass — Importación de alumnos"],
  [""],
  ["Llena las tres pestañas de abajo: «students», «packages», «bookings»."],
  ["NO cambies los encabezados (la fila 1 de cada pestaña). El sistema los lee tal cual."],
  ["Borra las filas de ejemplo antes de la importación final."],
  [""],
  ["Pestaña «students» — quién es cada alumno"],
  ["  student_ref : etiqueta corta y única que tú inventas (ej. maria-h). Une las pestañas."],
  ["  name        : nombre completo (obligatorio)."],
  [
    "  email       : su correo. Necesario para que el alumno entre solo; puede ir vacío y agregarse después.",
  ],
  ["  phone       : formato +52 y número, sin espacios (ej. +5215555000001)."],
  ["  timezone    : déjalo en America/Mexico_City salvo que el alumno esté en otra zona."],
  ["  locale      : es-MX."],
  [""],
  ["Pestaña «packages» — qué pagó cada alumno"],
  ["  package_ref    : etiqueta corta y única del paquete (ej. maria-h-p1)."],
  ["  student_ref    : debe coincidir con la pestaña students."],
  ["  classes_total  : clases que incluye el paquete."],
  ["  classes_used   : clases YA TOMADAS (no las futuras agendadas). 0 si es nuevo."],
  ["  price_paid_mxn : pesos (ej. 5500). Sin símbolo $."],
  ["  purchased_date : AAAA-MM-DD (ej. 2026-05-01)."],
  ["  expires_date   : AAAA-MM-DD, o vacío si no vence."],
  ["  status         : active (activo), paused (en pausa) o expired (vencido)."],
  ["  paused = pausado: conserva el saldo pero no se puede reservar hasta reactivar."],
  [""],
  ["Pestaña «bookings» — las clases ya agendadas"],
  ["  Clases FUTURAS acordadas: status = scheduled. Bloquean ese horario en el calendario."],
  ["  Clases PASADAS (opcional, solo historial): status = completed."],
  ["  start_datetime : AAAA-MM-DD HH:MM en hora local (ej. 2026-06-04 10:00)."],
  ["  duration_min   : minutos (vacío = 50)."],
  ["  Dos clases scheduled no pueden tener el mismo horario."],
];

// --- Styles (numFmtId 49 = text) ---
const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// --- Assemble worksheets ---
const sheets = [
  { name: "Instrucciones", xml: sheetXml(instrucciones, { widths: [95] }) },
  {
    name: "students",
    xml: sheetXml(students, { widths: [14, 24, 28, 18, 22, 8] }),
  },
  {
    name: "packages",
    xml: sheetXml(packages, {
      widths: [14, 14, 13, 13, 15, 15, 14, 10],
      validations: [{ col: 7, values: ["active", "paused", "expired"] }],
    }),
  },
  {
    name: "bookings",
    xml: sheetXml(bookings, {
      widths: [14, 14, 20, 13, 12],
      validations: [{ col: 4, values: ["scheduled", "completed"] }],
    }),
  },
];

const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
  .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
  .join("")}</sheets></workbook>`;

const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
  .map(
    (s, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  )
  .join(
    "",
  )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
  .map(
    (s, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join(
    "",
  )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const parts = [
  ["[Content_Types].xml", contentTypes],
  ["_rels/.rels", rootRels],
  ["xl/workbook.xml", workbookXml],
  ["xl/_rels/workbook.xml.rels", workbookRels],
  ["xl/styles.xml", stylesXml],
  ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
];

// --- Minimal ZIP writer (deflate) ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const local = [];
const central = [];
let offset = 0;

for (const [name, content] of parts) {
  const nameBuf = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const comp = deflateRawSync(data);
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); // deflate
  lh.writeUInt16LE(0, 10);
  lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  local.push(lh, nameBuf, comp);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(offset, 42);
  central.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + comp.length;
}

const centralBuf = Buffer.concat(central);
const localBuf = Buffer.concat(local);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(parts.length, 8);
eocd.writeUInt16LE(parts.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(localBuf.length, 16);
eocd.writeUInt16LE(0, 20);

writeFileSync(OUT, Buffer.concat([localBuf, centralBuf, eocd]));
console.log(`✓ wrote ${OUT}`);

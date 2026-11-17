// Which build of pdf.js the in-call PDF viewer loads (#126).
//
// pdfjs-dist ships two builds. The modern one (`pdfjs-dist`, `build/*`) calls
// `Map.prototype.getOrInsertComputed`, `Math.sumPrecise`,
// `Uint8Array.prototype.toHex`/`fromBase64` and friends without polyfilling
// them, so on a browser that predates them — every iPhone below iOS 26.2, a
// Chrome 101 Android tablet — opening a PDF on a call threw inside pdf.js and
// the viewer showed "open it outside the call". The legacy build
// (`legacy/build/*`) polyfills them. A teacher on her iPhone saw the fallback
// for a PDF the student, on a current desktop Chrome, saw drawn.
//
// Two halves, because either alone lets a dependency bump or a tidy-up move it
// back silently:
//   1. the component names the legacy build for BOTH the main module and the
//      worker (the worker runs pdf.js's parser, and is where most of those
//      calls are);
//   2. the build it names actually renders a page on an engine with those
//      APIs removed — the browser the bug was about, simulated in Node.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  path.resolve(__dirname, "../../src/components/video/call-material-pdf.tsx"),
  "utf8",
);

function mainSpecifiers(): string[] {
  return [...SOURCE.matchAll(/import\(\s*["'](pdfjs-dist[^"']*)["']\s*\)/g)].map((m) => m[1]!);
}

function workerSpecifiers(): string[] {
  return [...SOURCE.matchAll(/new URL\(\s*["'](pdfjs-dist[^"']*)["']/g)].map((m) => m[1]!);
}

describe("the in-call PDF viewer's pdf.js build", () => {
  it("imports the legacy main module, and only that", () => {
    expect(mainSpecifiers()).toEqual(["pdfjs-dist/legacy/build/pdf.mjs"]);
  });

  it("loads the legacy worker, and only that", () => {
    expect(workerSpecifiers()).toEqual(["pdfjs-dist/legacy/build/pdf.worker.min.mjs"]);
  });

  it("names no modern-build path anywhere", () => {
    // A type-only import of the modern entry would be harmless, but a second
    // `import("pdfjs-dist")` or a `build/` worker URL is exactly the regression.
    expect(SOURCE).not.toMatch(/["']pdfjs-dist["']/);
    expect(SOURCE).not.toMatch(/["']pdfjs-dist\/build\//);
  });
});

// The APIs the modern build assumes and an iOS 18 / Chrome 101 engine lacks.
// Removed for the duration of this file and restored exactly afterwards, so the
// result does not depend on which Node runs the suite.
const MISSING: Array<[object, string]> = [
  [Map.prototype, "getOrInsertComputed"],
  [Map.prototype, "getOrInsert"],
  [WeakMap.prototype, "getOrInsertComputed"],
  [WeakMap.prototype, "getOrInsert"],
  [Math, "sumPrecise"],
  [Uint8Array, "fromBase64"],
  [Uint8Array, "fromHex"],
  [Uint8Array.prototype, "toBase64"],
  [Uint8Array.prototype, "toHex"],
];
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  MISSING.forEach(([target, key], i) => {
    saved.set(`${i}`, Object.getOwnPropertyDescriptor(target, key));
    delete (target as Record<string, unknown>)[key];
  });
});

afterAll(() => {
  MISSING.forEach(([target, key], i) => {
    const descriptor = saved.get(`${i}`);
    delete (target as Record<string, unknown>)[key];
    if (descriptor) Object.defineProperty(target, key, descriptor);
  });
});

// The smallest well-formed one-page PDF, built with a correct xref so pdf.js
// takes its normal parse path rather than its "reconstruct a broken file" one.
function onePagePdf(): Uint8Array {
  const content = "0 0 1 rg 10 10 50 50 re f";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe("on an engine without the modern build's APIs", () => {
  it("the build the viewer names parses a PDF and builds a page's drawing", async () => {
    const require = createRequire(import.meta.url);
    const [main] = mainSpecifiers();
    const [worker] = workerSpecifiers();
    expect(main).toBeDefined();
    expect(worker).toBeDefined();

    type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfjs = (await import(
      /* @vite-ignore */ pathToFileURL(require.resolve(main!)).href
    )) as Pdfjs;
    // In Node pdf.js runs its worker in-process ("fake worker"), importing it
    // from workerSrc — so the parser that runs here is the file the viewer
    // points its real worker at.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve(worker!)).href;

    const task = pdfjs.getDocument({
      data: onePagePdf(),
      useWasm: false,
      verbosity: 0,
    });
    try {
      const doc = await task.promise;
      expect(doc.numPages).toBe(1);
      const page = await doc.getPage(1);
      expect(page.getViewport({ scale: 1 }).width).toBe(200);
      // The operator list is everything a canvas render consumes; producing it
      // runs the worker's content-stream parser end to end, with no canvas.
      const ops = await page.getOperatorList();
      expect(ops.fnArray.length).toBeGreaterThan(0);
    } finally {
      await task.destroy();
    }
  });
});

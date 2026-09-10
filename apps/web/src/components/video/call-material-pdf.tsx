"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/components/locale-provider";

// The in-call PDF renderer: a teacher's uploaded PDF drawn page-by-page into
// canvases inside CallMaterialViewer, where an AI-drafted material renders its
// Markdown. Before this, picking a PDF mid-lesson opened a browser tab — which
// on the teacher's side buried the call behind it, and on the student's side
// was not offered at all (a file could not be sent to her). Both halves of that
// came from the same missing thing: nothing could draw a PDF inside the call.
//
// CANVAS, NEVER AN HTML SINK (D-17). A teacher's upload is untrusted content —
// the same premise that keeps .svg out of the inline image preview
// (packages/shared/src/material-file-kind.ts). So this renders through pdf.js's
// core API into a 2D canvas and stops there: no `<embed>`/`<iframe>`/`<object>`
// handing the file to the browser's own plugin, no text or annotation layer
// (both build DOM from file-controlled strings), no XFA (off by default, and
// it is an HTML-rendered form engine). Nothing from inside the document
// becomes markup, script or a navigable link — the page arrives as pixels.
//
// BUNDLED DEFAULTS ONLY, NO COPIED ASSET DIRECTORIES. pdf.js can be handed
// `cMapUrl`/`standardFontDataUrl`/`wasmUrl` pointing at directories copied out
// of the package, which would improve two narrow cases: a PDF whose text is in
// a non-embedded standard font, and one using CJK character maps. They are not
// wired up because the production image builds by invoking Next DIRECTLY
// rather than through the package scripts (see the Dockerfile's "Invoke Next
// directly" note), so a copy step in a `prebuild` would run on a laptop and
// silently not in the deploy — the failure mode being a PDF that renders in
// dev and loses its fonts in production. Anything that embeds its fonts (Word,
// Google Docs, Canva, LaTeX exports — in practice, nearly everything a teacher
// uploads) is unaffected. Wire them up by committing the assets, not by adding
// a build step this deploy path does not run.
//
// WHY NOT AN IFRAME, WHICH WOULD BE TEN LINES. Two independent reasons, either
// of which is enough. (1) CSP: `frame-src` is 'self' + Stripe and `object-src`
// is 'none' (src/lib/csp.ts) — framing R2 means widening a Tier 2 file for a
// third-party origin, when this needs nothing new (`connect-src` already
// allows the R2 host for the intro-video presigned PUT, `worker-src` already
// allows the module worker, and R2 CORS already permits GET from the app
// origins — infra/cloudflare/r2-cors.json). (2) Correctness: an iframe renders
// only if the STORED content-type is application/pdf, and that comes from the
// browser's `file.type` at upload (lib/storage/materials-upload.ts), which is
// empty for some drag-and-drop sources — those objects download instead of
// rendering, per-file and silently. Fetching the bytes ourselves doesn't care.
//
// pdfjs-dist is dynamically imported, so the ~1 MB of it stays out of every
// bundle that never opens a PDF — including the call page itself, which loads
// it only when a teacher or student actually picks one.

// Re-render only when the column changes width by more than this. A canvas is
// rasterised at a fixed pixel size, so every width change is a full re-render
// of every page; quantising means a drag-resize costs a handful of renders
// rather than one per animation frame.
const WIDTH_STEP_PX = 32;

function quantiseWidth(width: number): number {
  return Math.max(WIDTH_STEP_PX, Math.round(width / WIDTH_STEP_PX) * WIDTH_STEP_PX);
}

export function CallMaterialPdf({ url }: { url: string }) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  // The column's width drives the raster size. Measured rather than assumed:
  // the viewer's reading column is capped on a laptop but full-bleed on a
  // phone held in portrait, and a page rasterised for the wrong one is either
  // blurry or needlessly heavy.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth((prev) => (quantiseWidth(w) === prev ? prev : quantiseWidth(w)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || width === 0) return;
    // Every async step below checks this before touching the DOM: closing the
    // viewer mid-render (or resizing into a new run) must not paint pages from
    // the run it replaced, and must not leave a worker alive behind the call.
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // The worker ships as a separate module asset; `new URL(...,
        // import.meta.url)` is what both webpack (next build) and Turbopack
        // (next dev) resolve into an emitted, same-origin URL — which is what
        // `worker-src 'self'` allows. A bare package path would 404 in dev and
        // silently fall back to a main-thread "fake worker" that blocks the
        // call's own rendering while a page rasterises.
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();

        const task = pdfjs.getDocument({
          url,
          // WASM OFF, AND SAID OUT LOUD. pdf.js 6 reaches for WebAssembly on
          // two narrow paths (ICC colour conversion, JPEG 2000 images), which
          // would need `script-src 'wasm-unsafe-eval'` — not granted by this
          // app's CSP (src/lib/csp.ts). Both paths already no-op here because
          // no `wasmUrl` is configured, so this changes no behaviour; it
          // states the constraint at the call site, so wiring `wasmUrl` up
          // later is a decision about CSP rather than a one-line default that
          // starts failing silently in production.
          useWasm: false,
        });
        // The LOADING TASK owns teardown, not the document: destroying it
        // aborts any in-flight range request and terminates the worker, which
        // is what must not outlive a closed viewer on a live call.
        cleanup = () => {
          void task.destroy();
        };
        // The viewer can be closed during the dynamic import, which finishes
        // AFTER the effect's cleanup has already run — so the task created
        // here would never be torn down by it. Checked again right after
        // creating it, or a worker outlives the call that spawned it.
        if (cancelled) {
          void task.destroy();
          return;
        }
        const doc = await task.promise;
        if (cancelled) return;

        // Rasterise at the device's pixel ratio so a page is as sharp as the
        // Markdown next to it, capped at 2: a 3x phone rendering an A4 page at
        // full ratio allocates more canvas than the page is worth.
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
          const page = await doc.getPage(pageNumber);
          if (cancelled) return;
          const unscaled = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (width / unscaled.width) * ratio });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          // CSS size is the column width; the extra device pixels are what the
          // ratio above bought.
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.className = "mb-4 rounded-lg bg-white shadow-xs";
          canvas.setAttribute("role", "img");
          canvas.setAttribute(
            "aria-label",
            t("call.materialPdfPage", { page: pageNumber, total: doc.numPages }),
          );
          await page.render({
            canvas,
            viewport,
            // Page content only. An annotation's appearance stream is drawn
            // from data inside the file and is the one part of a render that
            // carries links and form widgets — nothing this viewer needs, and
            // the part of pdf.js closest to the sink D-17 exists to avoid.
            annotationMode: pdfjs.AnnotationMode.DISABLE,
          }).promise;
          if (cancelled) return;
          // Appended as each page finishes rather than all at the end: a
          // multi-page worksheet starts being readable at page one, which is
          // the page she is talking about.
          el.append(canvas);
          setState("ready");
        }
        // A valid PDF with no pages at all: nothing was appended, so the
        // viewer would otherwise sit on "opening…" forever.
        if (doc.numPages === 0) setState("failed");
      } catch {
        // Every failure lands here as one state: a network or CORS refusal on
        // the signed URL, an expired URL, a file that is not really a PDF. The
        // fallback below is the pre-existing behaviour (open it outside the
        // call), so nothing a teacher could do before stops working because
        // this renderer could not.
        if (!cancelled) setState("failed");
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
      el.replaceChildren();
    };
  }, [url, width, t]);

  return (
    <div>
      <div ref={containerRef} data-testid="call-material-pdf" />
      {state === "loading" && (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t("call.materialPdfLoading")}
        </p>
      )}
      {state === "failed" && (
        <div className="py-8 text-center">
          <p className="text-muted-foreground text-sm">{t("call.materialPreviewFailed")}</p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="call-material-pdf-fallback"
            className="mt-2 inline-block text-sm font-medium underline"
          >
            {t("call.materialOpenOutside")}
          </a>
        </div>
      )}
    </div>
  );
}

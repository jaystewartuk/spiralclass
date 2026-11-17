// @vitest-environment jsdom
//
// When the in-call PDF viewer cannot draw a PDF, the teacher still gets the
// "open it outside the call" fallback — and now production hears about it
// (#126). The old bare `catch {}` recorded nothing, so an iPhone teacher seeing
// the fallback on every PDF left no trace: the cause (a browser older than the
// pdf.js build) had to be inferred from which browsers sent materials at all.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";

(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Both hooks return a stable value in the app (a context's t, PostHog's one
// client); the mocks do too, or every render would re-run the viewer's effect.
const t = (key: string) => key;
vi.mock("@/components/locale-provider", () => ({
  useT: () => t,
  useLocale: () => "en",
}));

const capture = vi.fn();
const posthog = { capture };
vi.mock("posthog-js/react", () => ({
  usePostHog: () => posthog,
}));

const getDocument = vi.fn();
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  AnnotationMode: { DISABLE: 0 },
  getDocument: (...args: unknown[]) => getDocument(...args),
}));

// jsdom has no layout, so the column's width never arrives on its own; the
// viewer waits for one before it starts.
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe() {
    this.cb(
      [{ contentRect: { width: 640 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;

const { CallMaterialPdf } = await import("@/components/video/call-material-pdf");

const SIGNED_URL = "https://r2.example/materials/abc.pdf?X-Amz-Signature=secret";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  capture.mockReset();
  getDocument.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function loadingTask(promise: Promise<unknown>) {
  // A rejected promise nobody has awaited yet is still "handled" once the
  // viewer awaits it; attach a no-op so Node does not flag it in between.
  promise.catch(() => {});
  return { promise, destroy: vi.fn(async () => {}) };
}

async function renderAndSettle() {
  await act(async () => {
    root.render(<CallMaterialPdf url={SIGNED_URL} />);
  });
  // The dynamic import and the loading task each take a turn of the queue.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("CallMaterialPdf when pdf.js cannot draw the file", () => {
  it("shows the open-outside fallback and reports the error's name", async () => {
    // What an engine without Map.prototype.getOrInsertComputed produced.
    getDocument.mockReturnValue(
      loadingTask(Promise.reject(new TypeError("a.getOrInsertComputed is not a function"))),
    );

    await renderAndSettle();

    expect(container.querySelector('[data-testid="call-material-pdf-fallback"]')).not.toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith("call_material_pdf_render_failed", {
      errorName: "TypeError",
    });
  });

  it("reports pdf.js's own exception name, never its message or the signed URL", async () => {
    // pdf.js's exceptions carry their class name on `name` and, for a fetch
    // failure, the URL in the message — which here is a signed R2 URL.
    const error = Object.assign(new Error(`Unexpected server response (403) for ${SIGNED_URL}`), {
      name: "ResponseException",
    });
    getDocument.mockReturnValue(loadingTask(Promise.reject(error)));

    await renderAndSettle();

    expect(capture).toHaveBeenCalledWith("call_material_pdf_render_failed", {
      errorName: "ResponseException",
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain("X-Amz-Signature");
  });

  it("names a thrown non-Error as unknown rather than dropping the event", async () => {
    getDocument.mockReturnValue(loadingTask(Promise.reject("boom")));

    await renderAndSettle();

    expect(capture).toHaveBeenCalledWith("call_material_pdf_render_failed", {
      errorName: "unknown",
    });
  });

  it("reports a PDF with no pages, which also falls back", async () => {
    getDocument.mockReturnValue(loadingTask(Promise.resolve({ numPages: 0 })));

    await renderAndSettle();

    expect(container.querySelector('[data-testid="call-material-pdf-fallback"]')).not.toBeNull();
    expect(capture).toHaveBeenCalledWith("call_material_pdf_render_failed", {
      errorName: "no_pages",
    });
  });
});

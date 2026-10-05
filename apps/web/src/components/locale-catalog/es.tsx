"use client";

import type { ReactNode } from "react";
import { esMX } from "@spiralclass/shared/catalog/es";
import { CatalogProvider } from "../locale-provider";

// One language per module, so one language per chunk. See ./loader.tsx.
export default function SpanishCatalog({ children }: { children: ReactNode }) {
  return (
    <CatalogProvider locale="es" table={esMX}>
      {children}
    </CatalogProvider>
  );
}

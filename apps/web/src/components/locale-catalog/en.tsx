"use client";

import type { ReactNode } from "react";
import { en } from "@spiralclass/shared/catalog/en";
import { CatalogProvider } from "../locale-provider";

// One language per module, so one language per chunk. See ./loader.tsx.
export default function EnglishCatalog({ children }: { children: ReactNode }) {
  return (
    <CatalogProvider locale="en" table={en}>
      {children}
    </CatalogProvider>
  );
}

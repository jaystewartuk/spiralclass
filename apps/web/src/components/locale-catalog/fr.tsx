"use client";

import type { ReactNode } from "react";
import { fr } from "@spiralclass/shared/catalog/fr";
import { CatalogProvider } from "../locale-provider";

// One language per module, so one language per chunk. See ./loader.tsx.
export default function FrenchCatalog({ children }: { children: ReactNode }) {
  return (
    <CatalogProvider locale="fr" table={fr}>
      {children}
    </CatalogProvider>
  );
}

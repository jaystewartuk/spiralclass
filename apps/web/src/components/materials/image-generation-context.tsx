"use client";

import { createContext, useContext, type ReactNode } from "react";

// Whether the block editor may offer "Generate image". Decided on the server
// (it needs the image provider's credentials) by the page that hosts the
// editor, and read deep inside it by the add-block row, which is five
// components down from anything a page passes props to.
//
// Defaults to false, so an editor mounted without a provider offers upload
// only, never a control that would fail.
const MaterialImageGenerationContext = createContext(false);

export function MaterialImageGenerationProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <MaterialImageGenerationContext.Provider value={enabled}>
      {children}
    </MaterialImageGenerationContext.Provider>
  );
}

export function useMaterialImageGeneration(): boolean {
  return useContext(MaterialImageGenerationContext);
}

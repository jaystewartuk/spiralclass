"use client";

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MaterialForm, type ClassContentSource } from "@/components/materials/material-form";
import type { FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { useT } from "@/components/locale-provider";

// Inline "Edit" toggle for a library item authored with the "write" content
// type — mirrors LibraryEditForm's open/close pattern, but hands off to the
// same MaterialForm used to create it (docs/features/library-materials.md).
// File/link items keep using LibraryEditForm; their attachment isn't
// editable in place either way, so there's no body/AI/version-history need.

type LevelOption = { id: string; label: string };
type Template = { id: string; label: string; body: string };
type Revision = { id: string; body: string; source: ClassContentSource; createdAt: Date };

export function LibraryContentEditForm({
  material,
  levels,
  focusGroups = [],
  templates = [],
  revisions = [],
  aiEnabled,
  isPro,
  podcastEnabled = false,
}: {
  material: {
    id: string;
    body: string;
    source: ClassContentSource;
    label: string | null;
    levelId: string;
    visibility: string;
    focusTagIds: string[];
    // Must round-trip into MaterialForm — the save action clears a link the
    // form renders-but-doesn't-seed (see ExistingContentMaterial).
    linkUrl: string | null;
    storagePath: string | null;
  };
  levels: LevelOption[];
  focusGroups?: FocusGroup[];
  templates?: Template[];
  revisions?: Revision[];
  aiEnabled: boolean;
  isPro: boolean;
  podcastEnabled?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-4" aria-hidden />
        {t("common.edit")}
      </Button>
    );
  }

  return (
    <div className="order-last mt-2 w-full space-y-3 rounded-md border bg-muted/40 p-3">
      <MaterialForm
        scope="library"
        levels={levels}
        focusGroups={focusGroups}
        templates={templates}
        revisions={revisions}
        aiEnabled={aiEnabled}
        isPro={isPro}
        podcastEnabled={podcastEnabled}
        existing={material}
        onSaved={() => setOpen(false)}
        // Cancel renders inside MaterialForm's pinned action bar, next to
        // Save — a standalone button below the form would sit under the
        // sticky bar and never be reachable.
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

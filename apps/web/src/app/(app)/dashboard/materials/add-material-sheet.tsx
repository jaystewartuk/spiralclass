"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { MethodPicker, type MaterialCreateMode } from "@/components/materials/method-picker";
import { AiGenerateFlow } from "@/components/materials/ai-generate-flow";
import { ManualCreateForm } from "@/components/materials/manual-create-form";
import { UploadForm } from "@/components/materials/upload-form";
import type { FocusGroup } from "@/components/focus-tags/focus-tag-select";
import { useT } from "@/components/locale-provider";

type LevelOption = { id: string; label: string };
type Template = { id: string; label: string; body: string };
type SavedMaterial = { materialId: string; label: string | null };

// Method-picker entry step + one of three focused sub-flows, each with a Back
// control back to the picker, then a success panel on save. Extracted from
// AddMaterialSheet so the mode/success logic is testable without the Radix
// Sheet/Dialog chrome around it (see tests/materials/add-material-flow.test.ts).
export function AddMaterialFlow({
  levels,
  focusGroups,
  templates,
  aiEnabled,
  isPro,
  onViewMaterial,
}: {
  levels: LevelOption[];
  focusGroups: FocusGroup[];
  templates: Template[];
  aiEnabled: boolean;
  isPro: boolean;
  onViewMaterial: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<MaterialCreateMode | undefined>(undefined);
  const [saved, setSaved] = useState<SavedMaterial | null>(null);

  if (saved) {
    return (
      <div className="space-y-4">
        <p className="text-success text-sm font-medium">{t("web.materials.success.title")}</p>
        <div className="flex flex-col gap-2">
          <Button type="button" variant="secondary" onClick={onViewMaterial}>
            {t("web.materials.success.viewMaterial")}
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard/students">{t("web.materials.success.assign")}</Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSaved(null);
              setMode(undefined);
            }}
          >
            {t("web.materials.success.createAnother")}
          </Button>
        </div>
      </div>
    );
  }

  if (mode === undefined) {
    return <MethodPicker aiEnabled={aiEnabled} isPro={isPro} onSelect={setMode} />;
  }

  return (
    <div className="space-y-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 gap-1.5"
        onClick={() => setMode(undefined)}
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("common.back")}
      </Button>
      {mode === "ai" && (
        <AiGenerateFlow
          levels={levels}
          focusGroups={focusGroups}
          templates={templates}
          isPro={isPro}
          onSaved={setSaved}
        />
      )}
      {mode === "manual" && (
        <ManualCreateForm levels={levels} focusGroups={focusGroups} onSaved={setSaved} />
      )}
      {mode === "upload" && (
        <UploadForm levels={levels} focusGroups={focusGroups} onSaved={setSaved} />
      )}
    </div>
  );
}

// "Add material" trigger + slide-over drawer for the library page — the Radix
// Sheet chrome around AddMaterialFlow above.
type Props = {
  levels: LevelOption[];
  focusGroups: FocusGroup[];
  templates: Template[];
  aiEnabled: boolean;
  isPro: boolean;
};

export function AddMaterialSheet({ levels, focusGroups, templates, aiEnabled, isPro }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button className="gap-1.5">
          <Plus className="size-4" aria-hidden />
          {t("web.materials.addMaterial")}
        </Button>
      </SheetTrigger>
      <SheetContent className="max-w-none">
        <SheetHeader>
          <SheetTitle>{t("web.materials.addMaterial")}</SheetTitle>
          <SheetDescription>{t("materials.help")}</SheetDescription>
        </SheetHeader>
        <AddMaterialFlow
          levels={levels}
          focusGroups={focusGroups}
          templates={templates}
          aiEnabled={aiEnabled}
          isPro={isPro}
          onViewMaterial={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

"use client";

import { Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SubmitButton } from "@/components/ui/submit-button";
import { deleteLibraryMaterialAction } from "@/app/actions/library";
import { useT } from "@/components/locale-provider";

// Permanent delete, behind a confirmation.
//
// `deleteLibraryMaterialAction` is a HARD delete: it removes the storage object,
// sweeps the images embedded in the body, then drops the row and its student
// assignments by cascade. There is no undo and no restore — archiving is the
// reversible half, and it already sits in the same footer.
//
// It used to be a bare SubmitButton at the same visual weight as Archive, one
// click from a row the teacher had merely moused over. SubmitButton's own
// docstring records the consequence (rage-clicks on this footer); this is the
// other half of that fix — the spinner told her the click had registered, and
// the click was the thing that should have been asked about first.
//
// The dialog is not dismissed by hand on success: the action revalidates the
// list, the row unmounts, and the portal goes with it. A failed action leaves
// the row (and this dialog) exactly as they were.
export function DeleteMaterialButton({ materialId, name }: { materialId: string; name: string }) {
  const t = useT();

  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // The name is in the accessible label rather than the visible text:
          // a footer of five buttons repeating the title is noise on screen,
          // but "Delete" alone is ambiguous in a screen reader's element list,
          // where every row contributes one.
          aria-label={t("web.materials.deleteNamed", { name })}
          className="text-destructive hover:bg-destructive-bg hover:text-destructive gap-1.5"
        >
          <Trash2 className="size-4" aria-hidden />
          {t("common.delete")}
        </Button>
      }
      title={t("web.materials.deleteTitle")}
      description={name}
      footer={(close) => (
        // The form wraps the confirm button rather than the whole dialog so
        // `useFormStatus` — which reads the nearest ancestor form — sees this
        // submit and nothing else.
        <form action={deleteLibraryMaterialAction} className="flex w-full flex-wrap gap-2">
          <input type="hidden" name="materialId" value={materialId} />
          <SubmitButton variant="destructive" className="gap-1.5">
            <Trash2 className="size-4" aria-hidden />
            {t("web.materials.deleteConfirm")}
          </SubmitButton>
          <Button type="button" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
        </form>
      )}
    >
      <Alert variant="warning">
        <AlertDescription>{t("web.materials.deleteBody")}</AlertDescription>
      </Alert>
    </ConfirmDialog>
  );
}

import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { applyE2ESkipGuards, signInAsViaOtp } from "./_helpers";

// Focus tags ("Tags" in the nav) settings page — the grouped, autosaving
// manager (see tags-manager.tsx): a category renders as a labeled region ONCE
// with its tags nested as chips underneath, and every add/rename/delete saves
// immediately (no "Save changes" button). Walks: add a category → add a tag
// scoped to it → rename it → dismiss an edit without saving → reorder → delete
// and undo → delete for real → delete the (now empty) category — asserting
// after each step that the category's own name still appears exactly once
// regardless of how many tags it holds.
//
// The three steps that are not just plumbing:
//
//   * DISMISS DISCARDS. Escape (and the X, and a click outside) used to COMMIT
//     the dialog. Pinning it here because the failure is silent: an accidental
//     rename simply saves, and nothing on screen says it happened.
//   * UNDO RESTORES. The server archives rather than drops, so re-persisting
//     the pre-delete array un-archives the same row. This asserts the row comes
//     back at all; that it is the SAME row (its material links intact) is a
//     property of saveFocusTagsForTeacher's `archived: false` write.
//   * REORDER COMMITS WITH SAVE. Move to top is dialog state now, not a
//     write-through — so the flow has to save for it to take.
//
// Gated `extended` (not run by the default `pnpm test:e2e`, only with
// E2E_EXTENDED=1): new selectors haven't been validated against a live dev
// server yet — see the `extended` doc on applyE2ESkipGuards.
applyE2ESkipGuards({ extended: true });

const TEACHER_EMAIL = "alicia.moreno@spiralclass.test";

test("add a category, add/rename/reorder/delete a tag inside it, then delete the category", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAsViaOtp(page, TEACHER_EMAIL, "/settings/focus-tags");
  await expect(page).toHaveURL(/\/settings\/focus-tags/, { timeout: 30_000 });

  const runId = randomUUID().slice(0, 8);
  const categoryName = `E2E categoría ${runId}`;
  const tagName = `E2E etiqueta ${runId}`;
  const renamedTagName = `${tagName} (editada)`;
  const secondTagName = `E2E etiqueta ${runId} b`;

  // ---- add category ----
  await page.getByRole("button", { name: "Agregar categoría" }).first().click();
  await page.getByLabel(/nombre de categor.a/i).fill(categoryName);
  await page.getByRole("button", { name: "Guardar" }).click();

  const group = page.getByRole("region", { name: categoryName });
  await expect(group).toBeVisible({ timeout: 15_000 });
  // The category name renders exactly once as the group's own heading, even
  // once it holds multiple tags below — the bug this redesign fixes.
  await expect(page.getByText(categoryName, { exact: true })).toHaveCount(1);

  // ---- add a tag scoped to that category ----
  await group.getByRole("button", { name: `Agregar una etiqueta a ${categoryName}` }).click();
  await page.getByLabel("Nombre", { exact: true }).fill(tagName);
  await page.getByRole("button", { name: "Guardar" }).click();

  await expect(group.getByText(tagName, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(categoryName, { exact: true })).toHaveCount(1);

  // ---- dismissing the dialog discards, it does not save ----
  await group.getByText(tagName, { exact: true }).click();
  await page.getByLabel("Nombre", { exact: true }).fill("NO DEBE GUARDARSE");
  await page.keyboard.press("Escape");
  await expect(page.getByText("NO DEBE GUARDARSE", { exact: true })).toHaveCount(0);
  await expect(group.getByText(tagName, { exact: true })).toBeVisible();

  // ---- rename the tag ----
  await group.getByText(tagName, { exact: true }).click();
  await page.getByLabel("Nombre", { exact: true }).fill(renamedTagName);
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(group.getByText(renamedTagName, { exact: true })).toBeVisible({ timeout: 15_000 });

  // ---- reorder: jump the tag to the top of its category ----
  // The move is dialog state, so it only lands on Save. The resulting array
  // order itself is covered by packages/shared/src/reorder.test.ts, not
  // re-asserted here; this covers the round trip through the real save action.
  //
  // A SECOND tag first, because a category holding one tag has nothing to
  // reorder: since #1010 the reorder controls are correctly disabled at the
  // ends of the list, so the one-tag version of this step was asserting
  // against a button that can never be enabled — it only ever passed because
  // the control used to be clickable and do nothing.
  await group.getByRole("button", { name: `Agregar una etiqueta a ${categoryName}` }).click();
  await page.getByLabel("Nombre", { exact: true }).fill(secondTagName);
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(group.getByText(secondTagName, { exact: true })).toBeVisible({ timeout: 15_000 });

  // The renamed tag is now first and the new one second, so moving the SECOND
  // to the top is a move the UI will actually accept.
  await group.getByText(secondTagName, { exact: true }).click();
  await page.getByRole("button", { name: "Mover al principio" }).click();
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(group.getByText(renamedTagName, { exact: true })).toBeVisible({ timeout: 15_000 });

  // ---- delete the tag, then undo it ----
  await group.getByText(renamedTagName, { exact: true }).click();
  await page.getByRole("button", { name: "Eliminar", exact: true }).click();
  await page.getByRole("button", { name: "Sí, eliminar" }).click();
  await expect(group.getByText(renamedTagName, { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Deshacer" }).click();
  await expect(group.getByText(renamedTagName, { exact: true })).toBeVisible({ timeout: 15_000 });

  // ---- delete it for real ----
  await group.getByText(renamedTagName, { exact: true }).click();
  await page.getByRole("button", { name: "Eliminar", exact: true }).click();
  await page.getByRole("button", { name: "Sí, eliminar" }).click();
  await expect(group.getByText(renamedTagName, { exact: true })).toHaveCount(0);

  // ---- and the second tag, so the category really is empty ----
  // The category delete below is only offered on an EMPTY category, so the
  // extra tag the reorder step needed has to go too, or this test leaves a
  // category behind on a shared fixture for every later run to scroll past.
  await group.getByText(secondTagName, { exact: true }).click();
  await page.getByRole("button", { name: "Eliminar", exact: true }).click();
  await page.getByRole("button", { name: "Sí, eliminar" }).click();
  await expect(group.getByText(secondTagName, { exact: true })).toHaveCount(0);

  // ---- delete the now-empty category ----
  // Only possible because it is empty: a category with tags still in it shows
  // the reason instead of a delete control.
  await group.getByRole("button", { name: `Editar ${categoryName}` }).click();
  await page.getByRole("button", { name: "Eliminar", exact: true }).click();
  await page.getByRole("button", { name: "Sí, eliminar" }).click();
  await expect(page.getByRole("region", { name: categoryName })).toHaveCount(0);
});

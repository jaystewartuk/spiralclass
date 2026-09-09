import { MessageSquare } from "lucide-react";
import { getT } from "@/lib/i18n";

/**
 * The inbox with nothing open yet.
 *
 * There is no list here: the layout's rail already IS the list, at every
 * width — full-width at this route on a narrow window, and 20rem beside this
 * pane on a wide one. Rendering a second copy would be the same conversations
 * twice on screen, and two components polling the same endpoint to keep them
 * agreeing with each other. So this pane, which only exists on a wide window,
 * says which half of the screen to act on.
 */
export default async function TeacherMessagesPage() {
  const t = await getT();

  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <MessageSquare className="h-10 w-10 text-muted-foreground/40" aria-hidden />
      <p className="font-bold text-foreground">{t("web.messages.pickAConversation")}</p>
      <p className="max-w-prose text-sm text-muted-foreground">{t("web.messages.description")}</p>
    </main>
  );
}

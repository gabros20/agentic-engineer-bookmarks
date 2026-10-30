"use client";

import { MessagesSquare } from "lucide-react";
import { useState } from "react";
import { SavedList, SavedRow } from "@/components/shell/saved-list";
import { PanelBadge, PanelHeader } from "@/components/ui/panel-header";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import type { SavedChat } from "@/lib/chat-history";
import { useLanguage } from "@/lib/i18n";
import { useDeleteChat, useFetchChat, useSavedChats } from "@/lib/queries";
import { formatAge } from "@/lib/time";

// Saved chats (DB-backed, cross-device). The list comes from the shared query cache, so it is
// usually already loaded when the sheet opens; a row loads its full conversation before opening.

type Props = {
  onClose: () => void;
  onOpenChat: (chat: SavedChat) => void;
};

export function SavedChatsPanel({ onClose, onOpenChat }: Props) {
  const { t } = useLanguage();
  const chats = useSavedChats();
  const remove = useDeleteChat();
  const fetchChat = useFetchChat();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [reopenFailed, setReopenFailed] = useState(false);
  const items = chats.data ?? [];

  async function open(id: string) {
    if (openingId) return;
    setOpeningId(id);
    setReopenFailed(false);
    try {
      const chat = await fetchChat(id);
      if (chat) onOpenChat(chat);
      else setReopenFailed(true);
    } catch {
      setReopenFailed(true);
    } finally {
      setOpeningId(null);
    }
  }

  const alert = reopenFailed ? t("chat.reopenError") : remove.isError ? t("chat.deleteError") : null;

  return (
    <ResponsivePanel title={t("nav.chats")} onClose={onClose} className="h-[80dvh] sm:h-[min(40rem,85vh)] sm:max-w-lg">
      {(close) => (
        <>
          <PanelHeader
            icon={<MessagesSquare size={18} />}
            title={t("nav.chats")}
            badge={items.length ? <PanelBadge>{items.length}</PanelBadge> : null}
            closeLabel={t("chat.aria.close")}
            onClose={close}
          />
          <SavedList
            state={chats.isPending ? "loading" : chats.isError ? "error" : "ready"}
            count={items.length}
            empty={t("chat.historyEmpty")}
            errorText={t("chat.error")}
            alert={alert}
            icon={<MessagesSquare size={20} />}
          >
            {items.map((item, i) => (
              <SavedRow
                key={item.id}
                index={i}
                title={item.title}
                meta={[item.language.toUpperCase(), formatAge(item.createdAt, t), item.query].filter(Boolean).join(" · ")}
                busy={openingId === item.id}
                onOpen={() => void open(item.id)}
                onDelete={() => remove.mutate(item.id)}
                deleteLabel={t("saved.delete")}
              />
            ))}
          </SavedList>
        </>
      )}
    </ResponsivePanel>
  );
}

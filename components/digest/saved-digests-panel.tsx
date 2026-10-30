"use client";

import { Layers } from "lucide-react";
import { SavedList, SavedRow } from "@/components/shell/saved-list";
import { PanelBadge, PanelHeader } from "@/components/ui/panel-header";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import type { SavedDigest } from "@/lib/digest-cache";
import { useLanguage } from "@/lib/i18n";
import { useDeleteDigest, useSavedDigests } from "@/lib/queries";
import { formatAge } from "@/lib/time";

// Saved digests (DB-backed, cross-device), one per query, newest first.

type Props = {
  onClose: () => void;
  onOpenDigest: (digest: SavedDigest) => void;
};

export function SavedDigestsPanel({ onClose, onOpenDigest }: Props) {
  const { t } = useLanguage();
  const digests = useSavedDigests();
  const remove = useDeleteDigest();
  const items = digests.data ?? [];

  return (
    <ResponsivePanel title={t("saved.title")} onClose={onClose} className="h-[80dvh] sm:h-[min(40rem,85vh)] sm:max-w-lg">
      {(close) => (
        <>
          <PanelHeader
            icon={<Layers size={18} />}
            title={t("saved.title")}
            badge={items.length ? <PanelBadge>{items.length}</PanelBadge> : null}
            closeLabel={t("saved.aria.close")}
            onClose={close}
          />
          <SavedList
            state={digests.isPending ? "loading" : digests.isError ? "error" : "ready"}
            count={items.length}
            empty={t("saved.empty")}
            errorText={t("saved.error")}
            alert={remove.isError ? t("saved.deleteError") : null}
            icon={<Layers size={20} />}
          >
            {items.map((item, i) => {
              const themes = item.themes.length === 1 ? t("saved.themes", { n: 1 }) : t("saved.themesPlural", { n: item.themes.length });
              const sources = item.sourceCount === 1 ? t("digest.sources", { n: 1 }) : t("digest.sourcesPlural", { n: item.sourceCount });
              return (
                <SavedRow
                  key={item.id ?? item.query}
                  index={i}
                  title={item.query}
                  meta={`${themes} · ${sources} · ${formatAge(item.createdAt, t)}`}
                  // Old entries (pre-TL;DR) only have `overall`.
                  preview={item.tldr || item.overall}
                  onOpen={() => onOpenDigest(item)}
                  onDelete={item.id ? () => remove.mutate(item.id!) : undefined}
                  deleteLabel={t("saved.delete")}
                />
              );
            })}
          </SavedList>
        </>
      )}
    </ResponsivePanel>
  );
}

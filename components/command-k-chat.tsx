"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from "ai";
import { BookmarkPlus, Check, Loader2, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { RemoveScroll } from "react-remove-scroll";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import type { SavedDigest } from "@/lib/digest-cache";
import { deriveChatTitle, makeChatId, saveChat } from "@/lib/chat-history";
import type {
  GetBookmarkInput,
  GetBookmarkResult,
  SearchBookmarksInput,
  SearchBookmarksResult,
} from "@/lib/chat-tools";
import type { DigestSource } from "@/lib/digest-schema";
import { useLanguage } from "@/lib/i18n";

export type ChatContextSnapshot = {
  language: "en" | "hu";
  query: string | null;
  precision: "exact" | "broad" | null;
  sources: DigestSource[];
  digest: SavedDigest | null;
};

type Props = {
  /** Live mode (allows new messages) requires both callbacks. */
  context?: ChatContextSnapshot;
  runSearch?: (input: SearchBookmarksInput) => Promise<SearchBookmarksResult>;
  getBookmark?: (input: GetBookmarkInput) => GetBookmarkResult;
  /** When set, the panel renders in read-only history mode. */
  initialMessages?: UIMessage[];
  onClose: () => void;
};

export function CommandKChat({
  context,
  runSearch,
  getBookmark,
  initialMessages,
  onClose,
}: Props) {
  const { t, lang } = useLanguage();
  const isHistory = !!initialMessages;

  const transport = useMemo(() => {
    if (isHistory) return undefined;
    return new DefaultChatTransport({
      api: "/api/chat",
      body: { context },
    });
  }, [context, isHistory]);

  const { messages, sendMessage, status, error, addToolOutput } = useChat({
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (isHistory) return;
      if (toolCall.dynamic) return;

      if (toolCall.toolName === "search_bookmarks" && runSearch) {
        try {
          const result = await runSearch(toolCall.input as SearchBookmarksInput);
          addToolOutput({
            tool: "search_bookmarks",
            toolCallId: toolCall.toolCallId,
            output: result,
          });
        } catch (err) {
          addToolOutput({
            tool: "search_bookmarks",
            toolCallId: toolCall.toolCallId,
            output: {
              count: 0,
              results: [],
              error: err instanceof Error ? err.message : String(err),
            } as unknown as SearchBookmarksResult,
          });
        }
        return;
      }

      if (toolCall.toolName === "get_bookmark" && getBookmark) {
        const result = getBookmark(toolCall.input as GetBookmarkInput);
        addToolOutput({
          tool: "get_bookmark",
          toolCallId: toolCall.toolCallId,
          output: result,
        });
      }
    },
  });

  // Esc to close.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-focus the prompt textarea once mounted (works across the open animation).
  // PromptInputTextarea doesn't forward refs, so query for the textarea inside our footer.
  const footerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (isHistory) return;
    const timer = window.setTimeout(() => {
      footerRef.current?.querySelector("textarea")?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [isHistory]);

  const [saved, setSaved] = useState(false);
  const handleSave = useCallback(() => {
    if (isHistory || messages.length === 0) return;
    saveChat({
      id: makeChatId(),
      title: deriveChatTitle(messages),
      language: lang,
      messages: messages as unknown[],
      query: context?.query ?? null,
      createdAt: new Date().toISOString(),
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }, [isHistory, messages, lang, context]);

  const onSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const text = (message.text ?? "").trim();
      if (!text) return;
      sendMessage({ text });
    },
    [sendMessage],
  );

  const headerLabel = useMemo(() => {
    if (isHistory) return t("chat.savedBadge");
    if (context?.query) return t("chat.contextSearch", { n: context.sources.length, q: context.query });
    return t("chat.contextNone");
  }, [isHistory, context, t]);

  return (
    <RemoveScroll>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-50 bg-[color:var(--color-ink)]/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.title")}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 12, transition: { duration: 0.15 } }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
        className="fixed inset-x-2 top-4 z-50 flex max-h-[calc(100dvh-1rem)] flex-col overflow-hidden rounded-xl border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] shadow-[0_20px_60px_rgba(20,20,19,0.18)] sm:inset-x-auto sm:left-1/2 sm:top-[8vh] sm:max-h-[80vh] sm:w-[34rem] sm:-translate-x-1/2"
      >
        <header className="flex items-center justify-between gap-3 border-b border-[color:var(--color-hairline)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-[color:var(--color-ink)]">
            <Sparkles size={18} className="shrink-0 text-[color:var(--color-primary)]" />
            <h2 className="truncate font-display text-[22px] leading-tight">{t("chat.title")}</h2>
            {status === "streaming" ? (
              <Loader2 size={14} className="shrink-0 animate-spin text-[color:var(--color-muted)]" />
            ) : null}
            {isHistory ? (
              <span className="shrink-0 rounded-sm bg-[color:var(--color-surface-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">
                {t("chat.savedBadge")}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!isHistory && messages.length > 0 ? (
              <button
                type="button"
                onClick={handleSave}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)] hover:text-[color:var(--color-ink)]"
              >
                {saved ? <Check size={12} /> : <BookmarkPlus size={12} />}
                <span className="hidden sm:inline">{saved ? t("chat.saved") : t("chat.save")}</span>
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t("chat.aria.close")}
              onClick={onClose}
              className="grid h-10 w-10 place-items-center rounded-full text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)] sm:h-8 sm:w-8"
            >
              <X size={20} className="sm:hidden" />
              <X size={18} className="hidden sm:block" />
            </button>
          </div>
        </header>

        {headerLabel ? (
          <div className="border-b border-[color:var(--color-hairline)] bg-[color:var(--color-surface-soft)] px-4 py-2 text-xs text-[color:var(--color-muted)]">
            {headerLabel}
          </div>
        ) : null}

        <Conversation className="flex-1">
          <ConversationContent className="px-4 py-4 sm:px-5">
            {messages.length === 0 ? (
              <ConversationEmptyState
                title={t("chat.title")}
                description={t("chat.empty")}
                icon={<Sparkles size={32} className="text-[color:var(--color-primary)]" />}
              />
            ) : null}

            <AnimatePresence initial={false}>
              {messages.map((m) => (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 32 }}
                >
                  <Message from={m.role}>
                    <MessageContent>
                      {m.parts?.map((p, i) => {
                        if (p.type === "text") {
                          // Assistant: render markdown. User: keep as plain text inside the cream bubble.
                          if (m.role === "assistant") {
                            return <MessageResponse key={i}>{p.text}</MessageResponse>;
                          }
                          return <span key={i} className="whitespace-pre-wrap">{p.text}</span>;
                        }
                        if (p.type === "reasoning") {
                          return (
                            <MessageResponse
                              key={i}
                              className="text-[12px] italic text-[color:var(--color-muted)]"
                            >
                              {p.text}
                            </MessageResponse>
                          );
                        }
                        if (p.type === "tool-search_bookmarks" || p.type === "tool-get_bookmark") {
                          const part = p as unknown as ToolPart;
                          return (
                            <Tool key={i} defaultOpen={false} className="mt-2">
                              <ToolHeader
                                type={part.type as `tool-${string}`}
                                state={part.state}
                              />
                              <ToolContent>
                                <ToolInput input={part.input} />
                                <ToolOutput output={renderToolOutput(part)} errorText={part.errorText} />
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      })}
                    </MessageContent>
                  </Message>
                </motion.div>
              ))}
            </AnimatePresence>

            {error ? (
              <div className="mt-3 rounded-lg border border-[color:var(--color-error)]/30 bg-[color:var(--color-error)]/5 p-3 text-sm text-[color:var(--color-error)]">
                {error.message}
              </div>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {!isHistory ? (
          <div
            ref={footerRef}
            className="border-t border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-3"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}
          >
            <PromptInput onSubmit={onSubmit}>
              <PromptInputBody>
                <PromptInputTextarea
                  placeholder={t("chat.placeholder")}
                  className="min-h-[44px] bg-[color:var(--color-surface-soft)]"
                />
                <PromptInputSubmit status={status === "streaming" ? "streaming" : undefined} />
              </PromptInputBody>
            </PromptInput>
          </div>
        ) : null}
      </motion.div>
    </RemoveScroll>
  );
}

function renderToolOutput(part: ToolPart) {
  if (part.state !== "output-available") return null;
  const output = part.output as unknown;
  if (!output) return null;

  if (part.type === "tool-search_bookmarks") {
    const r = output as SearchBookmarksResult;
    return (
      <div className="text-[13px]">
        <div className="mb-1.5 text-[color:var(--color-muted)]">{r.count} results</div>
        <ul className="space-y-1">
          {(r.results ?? []).slice(0, 8).map((s) => (
            <li key={s.id}>
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-md px-2 py-1 transition hover:bg-[color:var(--color-surface-card)]"
              >
                <div className="text-[12px] font-semibold text-[color:var(--color-primary)]">{s.author}</div>
                <div className="line-clamp-2 text-[color:var(--color-ink)]">{s.text}</div>
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (part.type === "tool-get_bookmark") {
    const r = output as GetBookmarkResult;
    if (!r?.found || !r.bookmark) {
      return <div className="text-sm text-[color:var(--color-muted)]">Not found.</div>;
    }
    return (
      <div className="text-[13px]">
        <div className="text-[12px] font-semibold text-[color:var(--color-primary)]">{r.bookmark.author}</div>
        <p className="mt-1 whitespace-pre-wrap text-[color:var(--color-ink)]">{r.bookmark.text}</p>
      </div>
    );
  }

  return null;
}

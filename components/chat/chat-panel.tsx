"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, type UIMessage } from "ai";
import { BookmarkPlus, Check, Copy, RotateCcw, Sparkles } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentTrace, type TraceLabels } from "@/components/ai/agent-trace";
import { Composer, type ComposerStatus } from "@/components/ai/composer";
import { Conversation, ConversationContent, ScrollToBottom } from "@/components/ai/conversation";
import { CitationProvider, Markdown } from "@/components/ai/markdown";
import { SourceStrip } from "@/components/ai/sources";
import { Suggestions } from "@/components/ai/suggestions";
import { IconButton, PanelBadge, PanelHeader } from "@/components/ui/panel-header";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import { deriveChatTitle, makeChatId, saveChat } from "@/lib/chat-history";
import { answerText, citedSources, sourcePool, splitFollowups, traceSteps } from "@/lib/chat-message";
import type { GetBookmarkInput, GetBookmarkResult, SearchBookmarksInput, SearchBookmarksResult } from "@/lib/chat-tools";
import type { SavedDigest } from "@/lib/digest-cache";
import type { DigestSource } from "@/lib/digest-schema";
import { useLanguage, type MessageKey } from "@/lib/i18n";
import { enter, exit } from "@/lib/motion";
import { queryKeys } from "@/lib/queries";

// ⌘K chat: ask the archive anything. The agent searches with client-side tools (the search runs
// in this tab against the same Worker as the search bar), and the panel shows it the way people
// now expect from AI answers (ChatGPT / Perplexity, Mobbin Oct 2026): one live activity row
// instead of a card per tool call, the answer as plain text (no assistant bubble) with numbered
// citations, the cited bookmarks as a swipeable strip, and follow-up questions to keep going.

export type ChatContextSnapshot = {
  language: "en" | "hu";
  query: string | null;
  precision: "exact" | "broad" | null;
  sources: DigestSource[];
  digest: SavedDigest | null;
  /** Live archive size (posts.length), for the system prompt's "~N saved posts". */
  archiveCount: number | null;
};

type Props = {
  /** Live mode (allows new messages) requires both callbacks. */
  context?: ChatContextSnapshot;
  runSearch?: (input: SearchBookmarksInput) => Promise<SearchBookmarksResult>;
  getBookmark?: (input: GetBookmarkInput) => GetBookmarkResult;
  /** When set, the panel renders in read-only history mode. */
  initialMessages?: UIMessage[];
  /** When set, this prompt is auto-sent once on mount as the first user message. */
  initialPrompt?: string;
  onClose: () => void;
};

export function ChatPanel({ context, runSearch, getBookmark, initialMessages, initialPrompt, onClose }: Props) {
  const { t, lang } = useLanguage();
  const isHistory = !!initialMessages;

  // The search this chat is grounded in can be dropped from the composer; the transport reads the
  // ref at send time, so the next turn goes out without it.
  const [grounded, setGrounded] = useState(Boolean(context?.query));
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = grounded || !context ? context : { ...context, query: null, precision: null, sources: [], digest: null };
  }, [grounded, context]);

  // A 429 from /api/chat doesn't surface usefully through useChat's error, so the transport's
  // fetch flags it and the panel shows a localized "daily limit reached" instead.
  const [limitReached, setLimitReached] = useState(false);
  const quotaFetch = useCallback<typeof fetch>(async (input, init) => {
    setLimitReached(false);
    const res = await fetch(input, init);
    if (res.status === 429) setLimitReached(true);
    return res;
  }, []);

  const transport = useMemo(
    () => (isHistory ? undefined : new DefaultChatTransport({ api: "/api/chat", body: () => ({ context: contextRef.current }), fetch: quotaFetch })),
    [isHistory, quotaFetch],
  );

  const { messages, setMessages, sendMessage, regenerate, stop, status, error, addToolOutput } = useChat({
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (isHistory || toolCall.dynamic) return;
      if (toolCall.toolName === "search_bookmarks" && runSearch) {
        let output: SearchBookmarksResult;
        try {
          output = await runSearch(toolCall.input as SearchBookmarksInput);
        } catch (err) {
          output = { count: 0, results: [], error: err instanceof Error ? err.message : String(err) } as SearchBookmarksResult;
        }
        addToolOutput({ tool: "search_bookmarks", toolCallId: toolCall.toolCallId, output });
        return;
      }
      if (toolCall.toolName === "get_bookmark" && getBookmark) {
        addToolOutput({ tool: "get_bookmark", toolCallId: toolCall.toolCallId, output: getBookmark(toolCall.input as GetBookmarkInput) });
      }
    },
  });

  const autoSent = useRef(false);
  useEffect(() => {
    if (isHistory || !initialPrompt || autoSent.current) return;
    autoSent.current = true;
    void sendMessage({ text: initialPrompt });
  }, [isHistory, initialPrompt, sendMessage]);

  const queryClient = useQueryClient();
  // One stable id per open conversation, so re-saving a grown chat updates the same DB row.
  const savedId = useRef<string | null>(null);
  const [saved, setSaved] = useState(false);
  const handleSave = useCallback(() => {
    if (isHistory || messages.length === 0) return;
    savedId.current ??= makeChatId();
    void saveChat({
      id: savedId.current,
      title: deriveChatTitle(messages),
      language: lang,
      messages: messages as unknown[],
      query: context?.query ?? null,
      createdAt: new Date().toISOString(),
    }).then(() => queryClient.invalidateQueries({ queryKey: queryKeys.chats }));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }, [isHistory, messages, lang, context, queryClient]);

  const send = useCallback((text: string) => void sendMessage({ text }), [sendMessage]);
  const newChat = useCallback(() => {
    stop();
    setMessages([]);
    savedId.current = null;
  }, [stop, setMessages]);

  const query = grounded ? (context?.query ?? null) : null;
  const subtitle = isHistory ? null : query ? t("chat.contextSearch", { q: query, n: context?.sources.length ?? 0 }) : t("chat.contextNone");
  const traceLabels = useTraceLabels();
  const busy = status === "submitted" || status === "streaming";

  return (
    <ResponsivePanel title={t("chat.title")} onClose={onClose} className="h-[92dvh] sm:h-[min(46rem,88vh)] sm:max-w-2xl">
      {(close) => (
        <>
          <PanelHeader
            icon={<Sparkles size={18} />}
            title={t("chat.title")}
            badge={isHistory ? <PanelBadge>{t("chat.savedBadge")}</PanelBadge> : null}
            subtitle={subtitle}
            closeLabel={t("chat.aria.close")}
            onClose={close}
            actions={
              !isHistory && messages.length > 0 ? (
                <>
                  <IconButton label={t("chat.new")} onClick={newChat}>
                    <RotateCcw size={17} />
                  </IconButton>
                  <IconButton label={saved ? t("chat.saved") : t("chat.save")} onClick={handleSave}>
                    {saved ? <Check size={18} /> : <BookmarkPlus size={18} />}
                  </IconButton>
                </>
              ) : null
            }
          />

          {messages.length === 0 && !isHistory ? (
            // The welcome reads top-down; only a conversation sticks to the bottom.
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
              <Welcome query={query} count={context?.sources.length ?? 0} onPick={send} />
            </div>
          ) : (
            <Conversation>
              <ConversationContent>
                {messages.map((message, index) => {
                  const last = index === messages.length - 1;
                  return message.role === "user" ? (
                    <UserMessage key={message.id} message={message} />
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      message={message}
                      live={!isHistory}
                      streaming={last && busy}
                      showFollowups={last && !busy && !isHistory}
                      onPick={send}
                      traceLabels={traceLabels}
                    />
                  );
                })}

                {busy && messages.at(-1)?.role === "user" ? <AgentTrace steps={[]} running live labels={traceLabels} /> : null}

                {limitReached || error ? (
                  <div
                    role="alert"
                    className="flex items-start justify-between gap-3 rounded-xl bg-[color:var(--color-error)]/8 p-3 text-[14px] text-[color:var(--color-error)]"
                  >
                    <span className="min-w-0">{limitReached ? t("chat.limit") : t("chat.failed")}</span>
                    {!limitReached ? (
                      <button
                        type="button"
                        onClick={() => void regenerate()}
                        className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium underline-offset-2 hover:underline"
                      >
                        {t("chat.retry")}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </ConversationContent>
              <ScrollToBottom label={t("chat.scrollDown")} />
            </Conversation>
          )}

          {!isHistory ? (
            <div className="shrink-0 px-3 pt-1 sm:px-5" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.75rem)" }}>
              <Composer
                onSubmit={send}
                onStop={stop}
                status={status as ComposerStatus}
                placeholder={t("chat.placeholder")}
                sendLabel={t("chat.send")}
                stopLabel={t("chat.stop")}
                context={query ? { label: query, clearLabel: t("chat.dropContext"), onClear: () => setGrounded(false) } : null}
                autoFocus={!initialPrompt}
              />
            </div>
          ) : null}
        </>
      )}
    </ResponsivePanel>
  );
}

function Welcome({ query, count, onPick }: { query: string | null; count: number; onPick: (text: string) => void }) {
  const { t } = useLanguage();
  const reduce = useReducedMotion();
  const starters = query
    ? (["chat.starter.q1", "chat.starter.q2", "chat.starter.q3", "chat.starter.q4"] as const).map((k) => t(k, { q: query }))
    : (["chat.starter.a1", "chat.starter.a2", "chat.starter.a3", "chat.starter.a4"] as const).map((k) => t(k));
  return (
    <motion.div initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0, transition: enter }} className="flex flex-col gap-4 sm:gap-6 sm:pt-2">
      <div>
        <h3 className="font-display text-[28px] leading-[1.1] text-[color:var(--color-ink)] sm:text-[34px]">{t("chat.welcome")}</h3>
        <p className="mt-2 text-[15px] leading-[1.5] text-[color:var(--color-muted)]">
          {query ? t("chat.welcomeGrounded", { q: query, n: count }) : t("chat.welcomeAll")}
        </p>
      </div>
      <Suggestions items={starters} onPick={onPick} label={t("chat.try")} />
    </motion.div>
  );
}

function UserMessage({ message }: { message: UIMessage }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0, transition: enter }}
      className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-[20px] rounded-br-md bg-[color:var(--color-surface-card)] px-4 py-2.5 text-[15px] leading-[1.5] text-[color:var(--color-ink)]"
    >
      {answerText(message)}
    </motion.div>
  );
}

function AssistantMessage({
  message,
  live,
  streaming,
  showFollowups,
  onPick,
  traceLabels,
}: {
  message: UIMessage;
  live: boolean;
  streaming: boolean;
  showFollowups: boolean;
  onPick: (text: string) => void;
  traceLabels: TraceLabels;
}) {
  const { t } = useLanguage();
  const steps = useMemo(() => traceSteps(message), [message]);
  const { body, followups } = useMemo(() => splitFollowups(answerText(message)), [message]);
  const pool = useMemo(() => sourcePool(message), [message]);
  const cited = useMemo(() => citedSources(body, pool), [body, pool]);
  const citations = useMemo(() => new Map(cited.map((s, i) => [s.id, i + 1])), [cited]);

  // Working = streaming with no answer yet, or a tool call still in flight.
  const working = streaming && (!body || steps.some((s) => s.active));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <AgentTrace steps={steps} running={working} live={live} labels={traceLabels} />

      {body ? (
        <CitationProvider value={citations}>
          <Markdown streaming={streaming}>{body}</Markdown>
        </CitationProvider>
      ) : null}

      <AnimatePresence>
        {!streaming && body ? (
          <motion.div
            key="after"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: enter }}
            exit={{ opacity: 0, transition: exit }}
            className="flex min-w-0 flex-col gap-4"
          >
            <CopyButton text={body} />
            <SourceStrip sources={cited} label={t("chat.sources", { n: cited.length })} />
            {showFollowups ? <Suggestions items={followups} onPick={onPick} label={t("chat.followups")} /> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);
  return (
    <div className="-ml-2 -mt-1 flex">
      <IconButton
        label={copied ? t("chat.copied") : t("chat.copy")}
        className="size-9"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </IconButton>
    </div>
  );
}

function useTraceLabels(): TraceLabels {
  const { t } = useLanguage();
  return useMemo(() => {
    const tr = (key: string, vars?: Record<string, string | number>) => t(`chat.trace.${key}` as MessageKey, vars);
    return {
      thinking: tr("thinking"),
      searching: (q) => tr("searching", { q }),
      reading: tr("reading"),
      thought: (s) => (s ? tr("thought", { n: s }) : tr("thoughtNoTime")),
      searched: (n, r) => tr("searched", { n, r }),
      read: (n) => tr("read", { n }),
      seconds: (n) => tr("seconds", { n }),
      failed: tr("failed"),
      results: (n) => String(n),
      readStep: (a) => (a ? tr("readStep", { a }) : tr("readStepAnon")),
    };
  }, [t]);
}

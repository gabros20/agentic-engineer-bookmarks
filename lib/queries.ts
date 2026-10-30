"use client";

import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteChatById, fetchChat, fetchSavedChats, type SavedChatMeta } from "@/lib/chat-history";
import { deleteDigestById, fetchDigestByQuery, fetchSavedDigests, normalize, type SavedDigest } from "@/lib/digest-cache";

// Server state (saved digests, saved chats, the digest for a query) through TanStack Query: the
// header counts, the saved panels and the digest panel share one cache, so a panel opens with its
// list already there (prefetched on hover/touch of its button), deletes are optimistic with
// rollback, and a generation or save refreshes every consumer at once. The archive and search
// stay on the data Web Worker; chat and digest generation stay on the AI SDK streams.

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export const queryKeys = {
  digests: ["digests"] as const,
  digest: (query: string) => ["digests", "by-query", normalize(query)] as const,
  chats: ["chats"] as const,
  chat: (id: string) => ["chats", id] as const,
};

export function useSavedDigests() {
  return useQuery({ queryKey: queryKeys.digests, queryFn: fetchSavedDigests });
}

export function useSavedChats() {
  return useQuery({ queryKey: queryKeys.chats, queryFn: fetchSavedChats });
}

/** The previously generated digest for a query (or null). */
export function useDigestForQuery(query: string | null) {
  return useQuery({
    queryKey: queryKeys.digest(query ?? ""),
    queryFn: () => fetchDigestByQuery(query ?? ""),
    enabled: Boolean(query),
  });
}

export function useFetchChat() {
  const client = useQueryClient();
  return (id: string) => client.fetchQuery({ queryKey: queryKeys.chat(id), queryFn: () => fetchChat(id) });
}

/** Optimistic delete: the row leaves the list at once and comes back if the server refuses. */
export function useDeleteDigest() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteDigestById,
    onMutate: async (id: string) => {
      await client.cancelQueries({ queryKey: queryKeys.digests });
      const previous = client.getQueryData<SavedDigest[]>(queryKeys.digests);
      client.setQueryData<SavedDigest[]>(queryKeys.digests, (rows) => rows?.filter((r) => r.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => client.setQueryData(queryKeys.digests, context?.previous),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.digests }),
  });
}

export function useDeleteChat() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteChatById,
    onMutate: async (id: string) => {
      await client.cancelQueries({ queryKey: queryKeys.chats });
      const previous = client.getQueryData<SavedChatMeta[]>(queryKeys.chats);
      client.setQueryData<SavedChatMeta[]>(queryKeys.chats, (rows) => rows?.filter((r) => r.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => client.setQueryData(queryKeys.chats, context?.previous),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.chats }),
  });
}

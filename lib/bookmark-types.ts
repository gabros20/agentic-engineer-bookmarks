export type BookmarkPayload = {
  ok: boolean;
  schema_version: string;
  metadata?: {
    generated_at?: string;
    source?: string;
    filter?: string;
    max_requested?: number;
    scanned_count?: number;
    pages_fetched?: number;
    complete?: boolean;
    next_cursor?: string | null;
  };
  data: BookmarkPost[];
};

export type BookmarkPost = {
  id: string;
  text: string;
  author: {
    id?: string;
    name: string;
    screenName: string;
    profileImageUrl?: string;
    verified?: boolean;
  };
  metrics?: {
    likes?: number;
    retweets?: number;
    replies?: number;
    quotes?: number;
    views?: number;
    bookmarks?: number;
  };
  createdAt?: string;
  createdAtLocal?: string;
  createdAtISO?: string;
  media?: Array<{
    type?: string;
    url?: string;
    width?: number;
    height?: number;
    /** Poster image for video/GIF items (X's own first-frame still on pbs.twimg.com). */
    thumbnail?: string;
    durationMs?: number;
  }>;
  urls?: string[];
  isRetweet?: boolean;
  retweetedBy?: string | null;
  lang?: string;
  score?: number | null;
  articleTitle?: string;
  articleText?: string;
  quotedTweet?: {
    id?: string;
    text?: string;
    author?: {
      screenName?: string;
      name?: string;
    };
  };
};

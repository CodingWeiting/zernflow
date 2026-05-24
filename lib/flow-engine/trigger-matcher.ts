import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

interface IncomingMessage {
  text?: string;
  postbackPayload?: string;
  quickReplyPayload?: string;
  sender?: { id: string };
}

/** Comment from Zernio's `comment.received` webhook, trimmed to matching needs. */
export interface IncomingComment {
  text: string;
  /** Zernio internal post ID */
  postId: string;
  /** Platform's native post ID (Meta / IG / FB) */
  platformPostId: string;
}

/** Config stored in `triggers.config` for `comment_keyword` triggers. */
export interface CommentTriggerConfig {
  keywords?: Array<
    | string
    | { value: string; matchType?: "exact" | "contains" | "startsWith" }
  >;
  /** Whitelist of Zernio post IDs. Empty / missing = match any post. */
  postIds?: string[];
  /** Optional public reply text the flow node can read. */
  replyText?: string;
}

type Trigger = Database["public"]["Tables"]["triggers"]["Row"];

export async function matchTrigger(
  supabase: SupabaseClient<Database>,
  channelId: string,
  conversationId: string,
  message: IncomingMessage
): Promise<Trigger | null> {
  // Get all active triggers for this channel (or global triggers with null channel_id)
  const { data: triggers } = await supabase
    .from("triggers")
    .select("*, flows!inner(status)")
    .or(`channel_id.eq.${channelId},channel_id.is.null`)
    .eq("is_active", true)
    .eq("flows.status", "published")
    .order("priority", { ascending: false });

  if (!triggers || triggers.length === 0) return null;

  // Priority order: postback > quick_reply > keyword > welcome > default
  // 1. Check postback triggers
  if (message.postbackPayload) {
    const match = triggers.find(
      (t) =>
        t.type === "postback" &&
        (t.config as { payload?: string })?.payload === message.postbackPayload
    );
    if (match) return match;
  }

  // 2. Check quick_reply triggers
  if (message.quickReplyPayload) {
    const match = triggers.find(
      (t) =>
        t.type === "quick_reply" &&
        (t.config as { payload?: string })?.payload ===
          message.quickReplyPayload
    );
    if (match) return match;
  }

  // 3. Check keyword triggers
  if (message.text) {
    const text = message.text.toLowerCase().trim();

    for (const trigger of triggers.filter((t) => t.type === "keyword")) {
      const config = trigger.config as {
        keywords?: Array<string | { value: string; matchType?: "exact" | "contains" | "startsWith" }>;
        matchType?: "exact" | "contains" | "startsWith";
      };

      if (!config.keywords) continue;

      for (const kw of config.keywords) {
        // Support both formats: plain string or { value, matchType } object
        const keyword = (typeof kw === "string" ? kw : kw.value).toLowerCase();
        const matchType =
          (typeof kw === "object" && kw.matchType) || config.matchType || "contains";

        if (matchType === "exact" && text === keyword) return trigger;
        if (matchType === "contains" && text.includes(keyword)) return trigger;
        if (matchType === "startsWith" && text.startsWith(keyword))
          return trigger;
      }
    }
  }

  // 4. Check welcome trigger (first inbound message for this contact on this channel)
  // Count inbound messages in this specific conversation. If this is the only one
  // (count === 1), it means the current message is the contact's very first message.
  const { count } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound");

  if (count === 1) {
    const welcomeTrigger = triggers.find((t) => t.type === "welcome");
    if (welcomeTrigger) return welcomeTrigger;
  }

  // 5. Default trigger
  const defaultTrigger = triggers.find((t) => t.type === "default");
  return defaultTrigger || null;
}

/**
 * Match an incoming comment against `comment_keyword` triggers for a channel.
 *
 * Filtering order:
 *   1. Trigger.config.postIds whitelist (if set, comment.postId must be in it)
 *   2. Keyword match (exact / contains / startsWith)
 *
 * Returns the highest-priority matching trigger, or null.
 */
export async function matchCommentTrigger(
  supabase: SupabaseClient<Database>,
  channelId: string,
  comment: IncomingComment
): Promise<Trigger | null> {
  const text = comment.text.toLowerCase().trim();
  if (!text) return null;

  const { data: triggers } = await supabase
    .from("triggers")
    .select("*, flows!inner(status)")
    .or(`channel_id.eq.${channelId},channel_id.is.null`)
    .eq("type", "comment_keyword")
    .eq("is_active", true)
    .eq("flows.status", "published")
    .order("priority", { ascending: false });

  if (!triggers || triggers.length === 0) return null;

  for (const trigger of triggers) {
    const config = trigger.config as CommentTriggerConfig;

    // Post whitelist: if configured, comment's post must be in it.
    if (config.postIds?.length && !config.postIds.includes(comment.postId)) {
      continue;
    }

    if (!config.keywords?.length) continue;

    for (const kw of config.keywords) {
      const keyword = (typeof kw === "string" ? kw : kw.value).toLowerCase();
      const matchType =
        (typeof kw === "object" && kw.matchType) || "contains";

      if (matchType === "exact" && text === keyword) return trigger;
      if (matchType === "contains" && text.includes(keyword)) return trigger;
      if (matchType === "startsWith" && text.startsWith(keyword)) return trigger;
    }
  }

  return null;
}

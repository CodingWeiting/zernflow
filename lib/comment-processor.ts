import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeFlow } from "@/lib/flow-engine/engine";
import { matchCommentTrigger } from "@/lib/flow-engine/trigger-matcher";
import type { Database } from "@/lib/types/database";

type Supabase = SupabaseClient<Database>;
type Channel = Database["public"]["Tables"]["channels"]["Row"];

/**
 * Normalised comment-event payload accepted by `processCommentEvent`.
 *
 * Real Zernio `comment.received` webhooks arrive in this exact shape (see
 * @zernio/node `WebhookPayloadComment`); the cron poller synthesises the
 * same shape from `listInboxComments` + `getInboxPostComments` so both code
 * paths run through the same handler.
 */
export interface CommentEventPayload {
  event: "comment.received";
  comment: {
    id: string;
    postId: string;
    platformPostId: string;
    platform: string;
    text: string;
    author: {
      id: string;
      username: string | null;
      name: string;
      picture: string | null;
    };
    createdAt: string;
    isReply: boolean;
    parentCommentId: string | null;
    /** Optional: cron polling can set this from Zernio's `isOwner` field. */
    isOwner?: boolean;
  };
  post: { id: string; platformPostId: string };
  account: { id: string; platform: string; username: string };
  timestamp: string;
}

/**
 * Core comment-event processor.
 *
 * Steps:
 *   1. Skip replies-to-replies and self-comments (Zernio's `isOwner` is the
 *      authoritative source for self-comments; the author.id === account.id
 *      check below is kept as a defensive fallback for raw webhooks).
 *   2. Match the comment against `comment_keyword` triggers on this channel.
 *   3. If no trigger fires, still log the comment (so dedup + analytics work).
 *   4. Upsert contact + conversation, run the matched flow with comment
 *      context variables.
 *   5. Write analytics + log row.
 *
 * Returns a NextResponse so the webhook route can pipe it straight back, or
 * the cron route can read `.json()` from it for summary stats.
 */
export async function processCommentEvent(
  supabase: Supabase,
  channel: Channel,
  payload: CommentEventPayload
): Promise<NextResponse> {
  const { comment } = payload;

  if (comment.isReply) {
    return NextResponse.json({ ok: true, skipped: true, reason: "is_reply" });
  }

  // Zernio's listInboxComments marks `isOwner: true` for the connected
  // account's own comments. The webhook payload doesn't currently include
  // this field, so the author.id === account.id check below is the
  // belt-and-braces fallback (it never actually matches because account.id
  // is Zernio's internal account ID while author.id is the platform's user
  // ID — different namespaces — but harmless).
  if (comment.isOwner || comment.author.id === payload.account.id) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "self_comment",
    });
  }

  const trigger = await matchCommentTrigger(supabase, channel.id, {
    text: comment.text,
    postId: comment.postId,
    platformPostId: comment.platformPostId,
  });

  const baseLog = {
    channel_id: channel.id,
    workspace_id: channel.workspace_id,
    post_id: comment.postId,
    platform_comment_id: comment.id,
    author_id: comment.author.id,
    author_name: comment.author.name || null,
    author_username: comment.author.username || null,
    comment_text: comment.text,
  };

  if (!trigger) {
    await supabase.from("comment_logs").upsert(
      {
        ...baseLog,
        matched_trigger_id: null,
        dm_sent: false,
        reply_sent: false,
      },
      { onConflict: "channel_id,platform_comment_id" }
    );
    return NextResponse.json({ ok: true, matched: false });
  }

  // ── Upsert contact ────────────────────────────────────────────────────────
  const senderId = comment.author.id;
  const senderName = comment.author.name || comment.author.username || senderId;

  let contactId: string;
  const { data: existingContactChannel } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", channel.id)
    .eq("platform_sender_id", senderId)
    .maybeSingle();

  if (existingContactChannel) {
    contactId = existingContactChannel.contact_id;
    await supabase
      .from("contacts")
      .update({ last_interaction_at: new Date().toISOString() })
      .eq("id", contactId);
  } else {
    const { data: newContact } = await supabase
      .from("contacts")
      .insert({
        workspace_id: channel.workspace_id,
        display_name: senderName,
        avatar_url: comment.author.picture || null,
        last_interaction_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (!newContact) {
      return NextResponse.json(
        { error: "Failed to create contact" },
        { status: 500 }
      );
    }
    contactId = newContact.id;

    await supabase.from("contact_channels").insert({
      contact_id: contactId,
      channel_id: channel.id,
      platform_sender_id: senderId,
      platform_username: comment.author.username || null,
    });
  }

  // ── Upsert conversation (DM target for Private Reply node) ───────────────
  const { data: conversation } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contactId,
        platform: channel.platform,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_message_preview: `[Comment] ${comment.text.slice(0, 80)}`,
      },
      { onConflict: "channel_id,contact_id" }
    )
    .select("id")
    .single();

  if (!conversation) {
    return NextResponse.json(
      { error: "Failed to upsert conversation" },
      { status: 500 }
    );
  }

  // ── Execute the flow ──────────────────────────────────────────────────────
  let flowError: string | null = null;
  try {
    await executeFlow(supabase, {
      triggerId: trigger.id,
      flowId: trigger.flow_id,
      channelId: channel.id,
      contactId,
      conversationId: conversation.id,
      workspaceId: channel.workspace_id,
      lateAccountId: channel.late_account_id,
      incomingMessage: {
        text: comment.text,
        sender: {
          id: senderId,
          name: comment.author.name || undefined,
          username: comment.author.username || undefined,
        },
      },
      variables: {
        comment_text: comment.text,
        comment_id: comment.id,
        commenter_name: senderName,
        commenter_username: comment.author.username || "",
        post_id: comment.postId,
        platform_post_id: comment.platformPostId,
      },
    });
  } catch (err) {
    flowError = err instanceof Error ? err.message : String(err);
    console.error("Comment flow execution error:", err);
  }

  // ── Analytics + log ──────────────────────────────────────────────────────
  await supabase.from("analytics_events").insert({
    workspace_id: channel.workspace_id,
    flow_id: trigger.flow_id,
    contact_id: contactId,
    event_type: "comment_matched",
    metadata: {
      triggerId: trigger.id,
      postId: comment.postId,
      commentId: comment.id,
      flowError,
    },
  });

  await supabase.from("comment_logs").upsert(
    {
      ...baseLog,
      matched_trigger_id: trigger.id,
      dm_sent: !flowError,
      reply_sent: false,
      error: flowError,
    },
    { onConflict: "channel_id,platform_comment_id" }
  );

  return NextResponse.json({
    ok: true,
    matched: true,
    triggerId: trigger.id,
  });
}

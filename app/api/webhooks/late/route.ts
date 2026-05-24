import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { executeFlow } from "@/lib/flow-engine/engine";
import {
  matchTrigger,
  matchCommentTrigger,
} from "@/lib/flow-engine/trigger-matcher";
import type { Database } from "@/lib/types/database";
import crypto from "crypto";

type Supabase = Awaited<ReturnType<typeof createServiceClient>>;
type Channel = Database["public"]["Tables"]["channels"]["Row"];

// ── Zernio webhook payloads ─────────────────────────────────────────────────

interface MessageWebhookPayload {
  event: "message.received";
  message: {
    id: string;
    conversationId: string;
    platform: string;
    platformMessageId: string;
    direction: string;
    text: string | null;
    attachments: Array<{ type: string; url: string; payload?: string }>;
    sender: {
      id: string;
      name: string;
      username: string | null;
      picture: string | null;
    };
    sentAt: string;
    isRead: boolean;
  };
  conversation: {
    id: string;
    platformConversationId: string | null;
    participantId: string;
    participantName: string;
    participantUsername: string | null;
    participantPicture: string | null;
    status: string;
  };
  account: {
    id: string;
    platform: string;
    username: string;
    displayName: string;
  };
  metadata?: {
    quickReplyPayload?: string;
    callbackData?: string;
    postbackPayload?: string;
    postbackTitle?: string;
  };
  timestamp: string;
}

interface CommentWebhookPayload {
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
  };
  post: { id: string; platformPostId: string };
  account: { id: string; platform: string; username: string };
  timestamp: string;
}

type WebhookPayload = MessageWebhookPayload | CommentWebhookPayload;

// ── Webhook handler ─────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    return await handleWebhook(request);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

async function handleWebhook(request: NextRequest) {
  const body = await request.text();
  // Zernio (formerly Late) currently sends `x-late-signature`. If they rename
  // the header in a future rebrand-cleanup, fall back to `x-zernio-signature`.
  const signature =
    request.headers.get("x-late-signature") ??
    request.headers.get("x-zernio-signature");

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    payload.event !== "message.received" &&
    payload.event !== "comment.received"
  ) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const supabase = await createServiceClient();
  const channel = await fetchChannel(supabase, payload.account.id);
  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const sigErr = verifySignature(channel.webhook_secret, signature, body);
  if (sigErr) return sigErr;

  if (payload.event === "comment.received") {
    return handleCommentWebhook(supabase, channel, payload);
  }

  // ── Message handler (existing logic) ─────────────────────────────────────

  const { message: msg, conversation: conv, account, metadata } = payload;

  // Ignore outbound messages (sent by the bot itself) to prevent loops
  if (msg.direction === "outbound") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Prevent loops: if the sender is another connected account in this
  // workspace, skip. This happens when both sides of a DM conversation
  // are connected (e.g. during testing).
  if (msg.sender.username) {
    const { data: senderChannel } = await supabase
      .from("channels")
      .select("id")
      .eq("workspace_id", channel.workspace_id)
      .eq("username", msg.sender.username)
      .eq("is_active", true)
      .maybeSingle();

    if (senderChannel) {
      return NextResponse.json({ ok: true, skipped: true, reason: "sender_is_own_account" });
    }
  }

  // ── Upsert contact ───────────────────────────────────────────────────────

  const senderId = msg.sender.id;
  const senderName = msg.sender.name || msg.sender.username || senderId;

  let contactId: string;
  const { data: existingContactChannel } = await supabase
    .from("contact_channels")
    .select("contact_id")
    .eq("channel_id", channel.id)
    .eq("platform_sender_id", senderId)
    .single();

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
        avatar_url: msg.sender.picture || null,
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
      platform_username: msg.sender.username || null,
    });

    await supabase.from("analytics_events").insert({
      workspace_id: channel.workspace_id,
      contact_id: contactId,
      event_type: "contact_created",
    });
  }

  // ── Upsert conversation ──────────────────────────────────────────────────

  const messagePreview = (msg.text || "").slice(0, 100);

  const { data: conversation } = await supabase
    .from("conversations")
    .upsert(
      {
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contactId,
        platform: channel.platform,
        late_conversation_id: conv.id,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_message_preview: messagePreview,
        unread_count: 1,
      },
      { onConflict: "channel_id,contact_id" }
    )
    .select("id, is_automation_paused")
    .single();

  if (!conversation) {
    return NextResponse.json(
      { error: "Failed to upsert conversation" },
      { status: 500 }
    );
  }

  if (existingContactChannel) {
    await supabase
      .rpc("increment_unread", {
        conv_id: conversation.id,
        preview: messagePreview,
      })
      .then(() => {});
  }

  // Messages are stored by Zernio (source of truth) — no local insert needed.

  // ── Flow engine ───────────────────────────────────────────────────────────

  if (!conversation.is_automation_paused) {
    const incomingMessage = {
      text: msg.text || undefined,
      postbackPayload: metadata?.postbackPayload || undefined,
      quickReplyPayload: metadata?.quickReplyPayload || undefined,
      callbackData: metadata?.callbackData || undefined,
      sender: {
        id: msg.sender.id,
        name: msg.sender.name,
        username: msg.sender.username || undefined,
      },
    };

    const handled = await handleGlobalKeywords(
      supabase,
      channel.workspace_id,
      contactId,
      msg.text || undefined
    );

    if (!handled) {
      const trigger = await matchTrigger(
        supabase,
        channel.id,
        conversation.id,
        incomingMessage
      );
      if (trigger) {
        try {
          await executeFlow(supabase, {
            triggerId: trigger.id,
            flowId: trigger.flow_id,
            channelId: channel.id,
            contactId,
            conversationId: conversation.id,
            workspaceId: channel.workspace_id,
            incomingMessage,
            lateConversationId: conv.id,
            lateAccountId: account.id,
          });
        } catch (err) {
          console.error("Flow execution error:", err);
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}

// ── Global keywords ─────────────────────────────────────────────────────────

async function handleGlobalKeywords(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  workspaceId: string,
  contactId: string,
  text: string | undefined
): Promise<boolean> {
  if (!text) return false;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("global_keywords")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.global_keywords) return false;

  const keywords = workspace.global_keywords as Array<{
    keyword: string;
    action?: string;
    flowId?: string;
  }>;

  const normalizedText = text.toLowerCase().trim();

  for (const kw of keywords) {
    if (normalizedText === kw.keyword.toLowerCase()) {
      if (kw.action === "unsubscribe") {
        await supabase
          .from("contacts")
          .update({ is_subscribed: false })
          .eq("id", contactId);
        return true;
      }
      if (kw.action === "subscribe") {
        await supabase
          .from("contacts")
          .update({ is_subscribed: true })
          .eq("id", contactId);
        return true;
      }
      return false;
    }
  }

  return false;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function fetchChannel(
  supabase: Supabase,
  accountId: string
): Promise<Channel | null> {
  const { data } = await supabase
    .from("channels")
    .select("*")
    .eq("late_account_id", accountId)
    .eq("is_active", true)
    .single();
  return data ?? null;
}

function verifySignature(
  secret: string | null,
  signature: string | null,
  body: string
): NextResponse | null {
  if (!secret) return null; // unsigned channel: skip check
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  try {
    const equal = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
    if (!equal) {
      return NextResponse.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }
  } catch {
    // length mismatch between buffers throws
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 401 }
    );
  }
  return null;
}

// ── Comment handler ─────────────────────────────────────────────────────────

async function handleCommentWebhook(
  supabase: Supabase,
  channel: Channel,
  payload: CommentWebhookPayload
): Promise<NextResponse> {
  const { comment } = payload;

  // Skip replies-to-replies (Meta only allows DM to top-level commenters)
  if (comment.isReply) {
    return NextResponse.json({ ok: true, skipped: true, reason: "is_reply" });
  }

  // Skip comments by the account itself (prevent self-trigger loops)
  if (comment.author.id === payload.account.id) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "self_comment",
    });
  }

  // ── Match trigger first; bail early if nothing fires
  const trigger = await matchCommentTrigger(supabase, channel.id, {
    text: comment.text,
    postId: comment.postId,
    platformPostId: comment.platformPostId,
  });

  // Always log the comment for analytics, regardless of match
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

  // ── Upsert conversation (DM destination for Private Reply node) ─────────
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
      reply_sent: false, // CommentReply node may set this; not tracked here
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

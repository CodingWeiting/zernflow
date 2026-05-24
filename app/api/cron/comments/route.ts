import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { createZernioClient } from "@/lib/zernio-client";
import {
  processCommentEvent,
  type CommentEventPayload,
} from "@/lib/comment-processor";

/**
 * POST /api/cron/comments
 *
 * Polls Zernio's inbox-comments endpoints for each active channel and runs
 * any new comments through the same processor the `comment.received`
 * webhook uses. Exists because Zernio (as of mid-2026) doesn't reliably
 * push IG/FB comment webhooks — it only exposes them via API. Until the
 * provider's webhook subscription works for comments, we poll.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (matches the existing
 * sequences + jobs cron auth pattern).
 *
 * Designed to be idempotent: comments already in `comment_logs` are skipped,
 * so the cron can run as often as Zernio's rate limits allow without
 * re-processing.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = await createServiceClient();

  // Active channels on platforms where listInboxComments is supported.
  const { data: channels } = await supabase
    .from("channels")
    .select(
      "id, platform, late_account_id, workspace_id, username, workspaces!inner(late_api_key_encrypted)"
    )
    .eq("is_active", true)
    .in("platform", [
      "instagram",
      "facebook",
      "twitter",
      "bluesky",
      "reddit",
    ]);

  if (!channels || channels.length === 0) {
    return NextResponse.json({ ok: true, channels: 0, processed: 0 });
  }

  let processed = 0;
  let matched = 0;
  let skipped = 0;
  const errors: Array<{ channelId: string; error: string }> = [];

  for (const channel of channels) {
    const ws = channel.workspaces as unknown as {
      late_api_key_encrypted: string | null;
    };
    if (!ws?.late_api_key_encrypted) continue;

    const zernio = createZernioClient(ws.late_api_key_encrypted);

    try {
      // Step 1: list posts on this account that have inbox comment activity.
      const postsRes = await zernio.comments.listInboxComments({
        query: {
          accountId: channel.late_account_id,
          limit: 30,
          sortBy: "date",
          sortOrder: "desc",
        },
      });

      const posts = postsRes.data?.data ?? [];

      for (const post of posts) {
        if (!post.id) continue;

        // Step 2: pull individual comments for the post.
        const commentsRes = await zernio.comments.getInboxPostComments({
          path: { postId: post.id },
          query: { accountId: channel.late_account_id, limit: 20 },
        });

        const comments = commentsRes.data?.comments ?? [];
        const commentIds = comments
          .map((c) => c.id)
          .filter((id): id is string => !!id);

        if (commentIds.length === 0) continue;

        // Step 3: dedup against comment_logs (anything already processed is
        // either already logged or already DM'd; either way, skip).
        const { data: seen } = await supabase
          .from("comment_logs")
          .select("platform_comment_id")
          .eq("channel_id", channel.id)
          .in("platform_comment_id", commentIds);

        const seenIds = new Set(
          seen?.map((r) => r.platform_comment_id) ?? []
        );

        for (const c of comments) {
          if (!c.id || seenIds.has(c.id)) continue;

          const payload: CommentEventPayload = {
            event: "comment.received",
            comment: {
              id: c.id,
              postId: post.id,
              platformPostId: post.id,
              platform: c.platform ?? channel.platform,
              text: c.message ?? "",
              author: {
                id: c.from?.id ?? "",
                username: c.from?.username ?? null,
                name: c.from?.name ?? c.from?.username ?? "",
                picture: null,
              },
              createdAt: c.createdTime ?? new Date().toISOString(),
              isReply: false,
              parentCommentId: null,
              isOwner: c.from?.isOwner ?? false,
            },
            post: { id: post.id, platformPostId: post.id },
            account: {
              id: channel.late_account_id,
              platform: channel.platform,
              username: channel.username ?? "",
            },
            timestamp: new Date().toISOString(),
          };

          // Re-fetch the channel as a full Row so the processor has the
          // workspace_id and webhook_secret fields it expects.
          const { data: fullChannel } = await supabase
            .from("channels")
            .select("*")
            .eq("id", channel.id)
            .single();

          if (!fullChannel) continue;

          const res = await processCommentEvent(supabase, fullChannel, payload);
          const body = (await res.json()) as {
            matched?: boolean;
            skipped?: boolean;
          };

          processed++;
          if (body.matched) matched++;
          else if (body.skipped) skipped++;
        }
      }
    } catch (err) {
      errors.push({
        channelId: channel.id,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`Cron error on channel ${channel.id}:`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    channels: channels.length,
    processed,
    matched,
    skipped,
    errors,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createZernioClient } from "@/lib/zernio-client";

async function getWorkspace(supabase: Awaited<ReturnType<typeof createClient>>) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id, workspaces(*)")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership?.workspaces) return null;
  return membership.workspaces;
}

/**
 * GET /api/v1/channels/[channelId]/posts
 *
 * Returns posts on the channel's connected account that have inbox activity
 * (i.e. at least one comment). Used by the flow editor's post-ID picker.
 *
 * Zernio's `listInboxComments` is misleadingly named — it actually returns
 * a list of *posts* with their comment counts, not individual comments.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const { channelId } = await params;
  const supabase = await createClient();
  const workspace = await getWorkspace(supabase);
  if (!workspace) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!workspace.late_api_key_encrypted) {
    return NextResponse.json(
      { error: "Zernio API key not configured" },
      { status: 400 }
    );
  }

  const { data: channel } = await supabase
    .from("channels")
    .select("id, late_account_id, platform")
    .eq("id", channelId)
    .eq("workspace_id", workspace.id)
    .single();

  if (!channel) {
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  }

  const zernio = createZernioClient(workspace.late_api_key_encrypted);

  try {
    const res = await zernio.comments.listInboxComments({
      query: {
        accountId: channel.late_account_id,
        limit: 50,
        sortBy: "date",
        sortOrder: "desc",
      },
    });

    const items = res.data?.data ?? [];

    // Strip the response down to what the picker actually renders.
    const posts = items
      .filter((p) => p.id)
      .map((p) => ({
        id: p.id as string,
        platform: p.platform ?? channel.platform,
        content: p.content ?? null,
        picture: p.picture ?? null,
        permalink: p.permalink ?? null,
        createdTime: p.createdTime ?? null,
        commentCount: p.commentCount ?? 0,
      }));

    return NextResponse.json({ posts });
  } catch (error) {
    console.error("Failed to fetch posts from Zernio:", error);
    return NextResponse.json(
      {
        error: `Failed to fetch posts: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 }
    );
  }
}

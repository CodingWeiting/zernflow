import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/v1/flows/[flowId]/unpublish
 *
 * Reverts a published flow back to draft and deactivates all of its
 * triggers so the webhook router stops matching against them. The flow
 * itself stays put (nodes/edges/version unchanged) — only status and
 * trigger activation flip. Republishing re-runs syncTriggersForFlow with
 * is_active=true, so this is fully reversible.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();
  if (!membership) {
    return NextResponse.json({ error: "No workspace" }, { status: 404 });
  }

  const { data: flow, error } = await supabase
    .from("flows")
    .update({ status: "draft", published_at: null })
    .eq("id", flowId)
    .eq("workspace_id", membership.workspace_id)
    .select("id, name, status, updated_at")
    .single();

  if (error || !flow) {
    return NextResponse.json(
      { error: error?.message || "Flow not found" },
      { status: 404 }
    );
  }

  await supabase
    .from("triggers")
    .update({ is_active: false })
    .eq("flow_id", flowId);

  return NextResponse.json(flow);
}

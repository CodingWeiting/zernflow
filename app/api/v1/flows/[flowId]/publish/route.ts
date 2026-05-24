import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncTriggersForFlow } from "@/lib/flow-engine/sync-triggers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ flowId: string }> }
) {
  const { flowId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: membership } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", user.id)
    .limit(1)
    .single();

  if (!membership)
    return NextResponse.json({ error: "No workspace" }, { status: 404 });

  // Get current flow
  const { data: flow, error } = await supabase
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .eq("workspace_id", membership.workspace_id)
    .single();

  if (error || !flow)
    return NextResponse.json(
      { error: error?.message || "Flow not found" },
      { status: 404 }
    );

  // Update flow status to published and increment version
  const newVersion = flow.version + 1;
  await supabase
    .from("flows")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      version: newVersion,
    })
    .eq("id", flowId);

  // Save version snapshot
  await supabase.from("flow_versions").insert({
    flow_id: flowId,
    version: newVersion,
    nodes: flow.nodes,
    edges: flow.edges,
    viewport: flow.viewport,
    name: flow.name,
    published_by: user.id,
  });

  // Rebuild triggers from the freshly published flow's nodes JSON.
  // This is authoritative — overwrites any drift between editor state
  // and the triggers table.
  const flowNodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  await syncTriggersForFlow(supabase, flowId, flowNodes, true);

  return NextResponse.json({ ...flow, version: newVersion });
}

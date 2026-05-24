import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/types/database";

/**
 * Trigger-node shape we read from `flows.nodes` JSON. Only fields used
 * by the sync logic are listed — the editor stores plenty more
 * (position, measured, selected, etc.) which we deliberately ignore.
 */
interface TriggerNodeData {
  triggerType?:
    | "keyword"
    | "postback"
    | "quick_reply"
    | "welcome"
    | "default"
    | "comment_keyword";
  channelId?: string | null;
  priority?: number;
  // ── per-type config carried straight into triggers.config:
  keywords?: unknown;
  payload?: string;
  postIds?: string[];
  replyText?: string;
  matchType?: "exact" | "contains" | "startsWith";
}

interface FlowNode {
  id: string;
  type?: string;
  data?: TriggerNodeData;
}

/**
 * Replace all `triggers` rows for a flow with fresh ones derived from the
 * flow's current `nodes` JSON.
 *
 * Strategy: delete-then-insert. References to triggers are weak (only
 * `comment_logs.matched_trigger_id` with ON DELETE SET NULL), so losing
 * IDs is acceptable.
 *
 * @param isActive   Whether the resulting triggers should fire. Typically
 *                   `flow.status === "published"` — i.e. drafts produce
 *                   inactive triggers, publish flips them on.
 */
export async function syncTriggersForFlow(
  supabase: SupabaseClient<Database>,
  flowId: string,
  nodes: FlowNode[] | null | undefined,
  isActive: boolean
): Promise<void> {
  const triggerNodes = (nodes ?? []).filter((n) => n.type === "trigger");

  // Wipe existing triggers for this flow (clean slate).
  await supabase.from("triggers").delete().eq("flow_id", flowId);

  if (triggerNodes.length === 0) return;

  const rows = triggerNodes
    .map((node) => buildTriggerRow(flowId, node, isActive))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return;

  await supabase.from("triggers").insert(rows);
}

function buildTriggerRow(
  flowId: string,
  node: FlowNode,
  isActive: boolean
): {
  flow_id: string;
  channel_id: string | null;
  type: NonNullable<TriggerNodeData["triggerType"]>;
  config: Json;
  is_active: boolean;
  priority: number;
} | null {
  const data = node.data ?? {};
  const triggerType = data.triggerType ?? "keyword";

  // Build config by picking only the fields relevant to this trigger type.
  const config: Record<string, Json> = {};

  if (
    (triggerType === "keyword" || triggerType === "comment_keyword") &&
    Array.isArray(data.keywords)
  ) {
    config.keywords = data.keywords as Json;
    if (data.matchType) config.matchType = data.matchType;
  }
  if (triggerType === "comment_keyword") {
    if (Array.isArray(data.postIds) && data.postIds.length > 0) {
      config.postIds = data.postIds as Json;
    }
    if (typeof data.replyText === "string" && data.replyText.length > 0) {
      config.replyText = data.replyText;
    }
  }
  if (
    (triggerType === "postback" || triggerType === "quick_reply") &&
    typeof data.payload === "string"
  ) {
    config.payload = data.payload;
  }

  return {
    flow_id: flowId,
    channel_id: data.channelId ?? null,
    type: triggerType,
    config: config as Json,
    is_active: isActive,
    priority: typeof data.priority === "number" ? data.priority : 0,
  };
}

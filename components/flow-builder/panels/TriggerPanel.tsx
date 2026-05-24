"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TriggerType } from "@/lib/types/database";

interface Keyword {
  value: string;
  matchType: "exact" | "contains" | "startsWith";
}

interface ChannelOption {
  id: string;
  platform: string;
  username: string | null;
  display_name: string | null;
}

interface TriggerPanelData {
  triggerType?: string;
  keywords?: Keyword[];
  payload?: string;
  channelId?: string | null;
  postIds?: string[];
  [key: string]: unknown;
}

interface TriggerPanelProps {
  data: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
}

const triggerTypes: Array<{ value: TriggerType; label: string; description: string }> = [
  { value: "keyword", label: "Keyword", description: "Triggered when a user sends a matching keyword" },
  { value: "postback", label: "Button Click", description: "Triggered when a user clicks a button" },
  { value: "quick_reply", label: "Quick Reply", description: "Triggered when a user taps a quick reply" },
  { value: "welcome", label: "Welcome Message", description: "Triggered when a user starts a conversation" },
  { value: "default", label: "Default Reply", description: "Triggered when no other trigger matches" },
  { value: "comment_keyword", label: "Comment Keyword", description: "Triggered by keywords in post comments" },
];

const matchTypes: Array<{ value: "exact" | "contains" | "startsWith"; label: string }> = [
  { value: "exact", label: "Exact match" },
  { value: "contains", label: "Contains" },
  { value: "startsWith", label: "Starts with" },
];

export function TriggerPanel({ data: rawData, onChange }: TriggerPanelProps) {
  const data = rawData as TriggerPanelData;
  const triggerType = data.triggerType || "keyword";
  const keywords = data.keywords || [];
  const [newKeyword, setNewKeyword] = useState("");
  const [newMatchType, setNewMatchType] = useState<"exact" | "contains" | "startsWith">("contains");
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/channels")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: { channels?: ChannelOption[] }) => {
        if (!cancelled) setChannels(body.channels ?? []);
      })
      .catch((err) => {
        if (!cancelled) console.error("Failed to load channels:", err);
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTriggerTypeChange = useCallback(
    (type: string) => {
      onChange({ ...data, triggerType: type });
    },
    [data, onChange]
  );

  const handleChannelChange = useCallback(
    (channelId: string) => {
      onChange({ ...data, channelId: channelId || null });
    },
    [data, onChange]
  );

  const addKeyword = useCallback(() => {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    const updated: Keyword[] = [...keywords, { value: trimmed, matchType: newMatchType }];
    onChange({ ...data, keywords: updated });
    setNewKeyword("");
  }, [data, keywords, newKeyword, newMatchType, onChange]);

  const removeKeyword = useCallback(
    (index: number) => {
      const updated = keywords.filter((_, i) => i !== index);
      onChange({ ...data, keywords: updated });
    },
    [data, keywords, onChange]
  );

  const updateKeywordMatchType = useCallback(
    (index: number, matchType: "exact" | "contains" | "startsWith") => {
      const updated = keywords.map((k, i) => (i === index ? { ...k, matchType } : k));
      onChange({ ...data, keywords: updated });
    },
    [data, keywords, onChange]
  );

  // ── Post IDs (comment_keyword only) ──────────────────────────────────────
  const postIds = data.postIds || [];
  const [newPostId, setNewPostId] = useState("");

  const addPostId = useCallback(() => {
    const trimmed = newPostId.trim();
    if (!trimmed) return;
    if (postIds.includes(trimmed)) {
      setNewPostId("");
      return;
    }
    onChange({ ...data, postIds: [...postIds, trimmed] });
    setNewPostId("");
  }, [data, postIds, newPostId, onChange]);

  const removePostId = useCallback(
    (id: string) => {
      onChange({ ...data, postIds: postIds.filter((p) => p !== id) });
    },
    [data, postIds, onChange]
  );

  const showKeywords = triggerType === "keyword" || triggerType === "comment_keyword";
  const showPostIds = triggerType === "comment_keyword";
  const showPayload = triggerType === "postback" || triggerType === "quick_reply";

  return (
    <div className="space-y-5">
      {/* Channel scope */}
      <div>
        <label className="mb-2 block text-xs font-semibold text-foreground">
          Channel
        </label>
        <select
          value={data.channelId ?? ""}
          onChange={(e) => handleChannelChange(e.target.value)}
          disabled={channelsLoading}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
        >
          <option value="">
            {channelsLoading ? "Loading channels…" : "All channels (any connected)"}
          </option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {(c.display_name || c.username || c.id) + ` · ${c.platform}`}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Which channel this trigger fires on. Leave as &ldquo;All channels&rdquo; for
          a global trigger.
        </p>
      </div>

      {/* Trigger Type */}
      <div>
        <label className="mb-2 block text-xs font-semibold text-foreground">
          Trigger Type
        </label>
        <div className="space-y-1.5">
          {triggerTypes.map((t) => (
            <label
              key={t.value}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                triggerType === t.value
                  ? "border-emerald-500 bg-emerald-50"
                  : "border-border bg-card hover:border-input"
              )}
            >
              <input
                type="radio"
                name="triggerType"
                value={t.value}
                checked={triggerType === t.value}
                onChange={() => handleTriggerTypeChange(t.value)}
                className="mt-0.5 h-4 w-4 border-input text-emerald-500 focus:ring-emerald-500"
              />
              <div>
                <p className="text-sm font-medium text-foreground">{t.label}</p>
                <p className="text-xs text-muted-foreground">{t.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Keywords Section */}
      {showKeywords && (
        <div>
          <label className="mb-2 block text-xs font-semibold text-foreground">
            Keywords
          </label>

          {/* Existing keywords */}
          {keywords.length > 0 && (
            <div className="mb-3 space-y-2">
              {keywords.map((keyword, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 rounded-lg border border-border bg-card p-2"
                >
                  <span className="flex-1 truncate text-sm text-foreground">
                    {keyword.value}
                  </span>
                  <select
                    value={keyword.matchType}
                    onChange={(e) =>
                      updateKeywordMatchType(index, e.target.value as "exact" | "contains" | "startsWith")
                    }
                    className="rounded border border-border bg-muted px-2 py-1 text-xs text-foreground"
                  >
                    {matchTypes.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeKeyword(index)}
                    className="rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add new keyword */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKeyword();
                }
              }}
              placeholder="Enter keyword..."
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <select
              value={newMatchType}
              onChange={(e) => setNewMatchType(e.target.value as "exact" | "contains" | "startsWith")}
              className="rounded-lg border border-border bg-card px-2 py-2 text-xs text-foreground focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              {matchTypes.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addKeyword}
              disabled={!newKeyword.trim()}
              className="rounded-lg bg-emerald-500 p-2 text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {keywords.length === 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Add keywords that will trigger this flow. Press Enter or click + to add.
            </p>
          )}
        </div>
      )}

      {/* Post ID whitelist (comment_keyword only) */}
      {showPostIds && (
        <div>
          <label className="mb-2 block text-xs font-semibold text-foreground">
            Restrict to specific posts (optional)
          </label>

          {postIds.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {postIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-mono text-foreground"
                >
                  {id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id}
                  <button
                    type="button"
                    onClick={() => removePostId(id)}
                    className="rounded-full p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground"
                    aria-label={`Remove ${id}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newPostId}
              onChange={(e) => setNewPostId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPostId();
                }
              }}
              placeholder="Paste a post ID..."
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button
              type="button"
              onClick={addPostId}
              disabled={!newPostId.trim()}
              className="rounded-lg bg-emerald-500 p-2 text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-1.5 text-xs text-muted-foreground">
            {postIds.length === 0
              ? "Leave empty to trigger on comments from any post. Add post IDs to limit the trigger to specific posts."
              : `Triggers only on comments on the ${postIds.length} listed post${postIds.length === 1 ? "" : "s"}.`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Tip: post IDs come from the comment webhook (visible in your <code className="font-mono">comment_logs</code> table after the first comment).
          </p>
        </div>
      )}

      {/* Payload Section */}
      {showPayload && (
        <div>
          <label className="mb-2 block text-xs font-semibold text-foreground">
            Payload
          </label>
          <input
            type="text"
            value={data.payload || ""}
            onChange={(e) => onChange({ ...data, payload: e.target.value })}
            placeholder="Enter payload value..."
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            The payload value to match when a {triggerType === "postback" ? "button is clicked" : "quick reply is tapped"}.
          </p>
        </div>
      )}
    </div>
  );
}

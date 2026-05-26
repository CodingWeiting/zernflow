"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { GitBranch, Loader2, Trash2 } from "lucide-react";
import type { FlowStatus } from "@/lib/types/database";

interface FlowCardProps {
  flow: {
    id: string;
    name: string;
    status: string;
    updated_at: string;
    nodeCount: number;
  };
  statusLabel: string;
  statusClasses: string;
  updatedLabel: string;
}

export function FlowCard({
  flow,
  statusLabel,
  statusClasses,
  updatedLabel,
}: FlowCardProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${flow.name}"? This can't be undone.`)) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Failed to delete: ${body.error ?? res.statusText}`);
        return;
      }
      router.refresh();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="group relative rounded-xl border border-border bg-card transition-colors hover:border-primary/50">
      <Link href={`/dashboard/flows/${flow.id}`} className="block p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1 pr-8">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-medium group-hover:text-primary transition-colors">
                {flow.name}
              </h3>
              <span
                className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClasses}`}
              >
                {statusLabel}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {flow.nodeCount} {flow.nodeCount === 1 ? "node" : "nodes"}
            </p>
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Updated {updatedLabel}
        </p>
      </Link>

      <button
        type="button"
        onClick={handleDelete}
        disabled={deleting}
        title="Delete flow"
        aria-label="Delete flow"
        className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
      >
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

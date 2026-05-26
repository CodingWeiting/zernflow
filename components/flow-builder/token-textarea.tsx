"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

export interface TokenDef {
  /** Internal key. Serialised as `{{token}}`. */
  token: string;
  /** Pill text shown to the user (without braces). */
  label: string;
  /** Tooltip on hover. */
  hint?: string;
}

interface TokenTextareaProps {
  /** Stored string with `{{token}}` markers (or plain text). */
  value: string;
  /** Called with the new stored string after any edit. */
  onChange: (next: string) => void;
  /** Tokens shown as clickable chips above the editor. */
  tokens: TokenDef[];
  placeholder?: string;
  /** Min rows for the editor area. */
  rows?: number;
}

const TOKEN_PATTERN = /\{\{([a-zA-Z_]\w*)\}\}/g;

// ── Serialisation: contenteditable DOM → `{{token}}` string ────────────────

function serialise(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node instanceof HTMLElement) {
      if (node.dataset.token) {
        out += `{{${node.dataset.token}}}`;
        return;
      }
      if (node.tagName === "BR") {
        out += "\n";
        return;
      }
      // Some browsers wrap lines in <div>; treat each block as a newline.
      const isBlock =
        node.tagName === "DIV" || node.tagName === "P";
      if (isBlock && out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
      }
      node.childNodes.forEach(walk);
    }
  };
  root.childNodes.forEach(walk);
  return out;
}

// ── Hydration: `{{token}}` string → DOM nodes ──────────────────────────────

function buildChip(def: TokenDef): HTMLSpanElement {
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.token = def.token;
  if (def.hint) span.title = def.hint;
  span.className =
    "mx-0.5 inline-flex select-none items-center rounded-md border border-emerald-400/60 bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 align-baseline dark:text-emerald-300";
  span.textContent = def.label;
  return span;
}

function hydrate(root: HTMLElement, text: string, tokens: TokenDef[]) {
  root.innerHTML = "";
  const byKey = new Map(tokens.map((t) => [t.token, t]));
  TOKEN_PATTERN.lastIndex = 0;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_PATTERN.exec(text)) !== null) {
    if (m.index > lastIndex) {
      root.appendChild(
        document.createTextNode(text.slice(lastIndex, m.index))
      );
    }
    const def = byKey.get(m[1]);
    if (def) {
      root.appendChild(buildChip(def));
    } else {
      // Unknown token — render as plain text so it round-trips intact.
      root.appendChild(document.createTextNode(m[0]));
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    root.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  // contenteditable refuses to land the caret in an empty element — append a
  // trailing ZWSP-like text node so the user can start typing immediately.
  if (root.childNodes.length === 0) {
    root.appendChild(document.createTextNode(""));
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export function TokenTextarea({
  value,
  onChange,
  tokens,
  placeholder,
  rows = 3,
}: TokenTextareaProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  // Track the last value that originated from THIS editor so external value
  // changes (programmatic reset, undo, etc.) trigger a rehydrate but
  // local typing doesn't blow away the caret.
  const lastEmittedRef = useRef<string>(value);

  // Rehydrate only when external value diverges from what we last emitted.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (value === lastEmittedRef.current) return;
    hydrate(el, value, tokens);
    lastEmittedRef.current = value;
  }, [value, tokens]);

  // First mount: render the initial value.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    hydrate(el, value, tokens);
    lastEmittedRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = serialise(el);
    lastEmittedRef.current = next;
    onChange(next);
  }, [onChange]);

  const insertToken = useCallback(
    (def: TokenDef) => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const chip = buildChip(def);
      const trailingSpace = document.createTextNode(" "); // non-breaking space for caret landing

      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(trailingSpace);
        range.insertNode(chip);
        // Move caret AFTER the trailing space (so user types after the chip)
        range.setStartAfter(trailingSpace);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.appendChild(chip);
        el.appendChild(trailingSpace);
        // Place caret at end
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      emit();
    },
    [emit]
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Make Enter a soft line break (single <br>) rather than a new block.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
    }
  };

  // Approximate height: each row ~22px + padding.
  const minHeight = Math.max(48, rows * 22 + 16);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tokens.map((t) => (
          <button
            key={t.token}
            type="button"
            onClick={() => insertToken(t)}
            title={t.hint ?? `Insert ${t.label}`}
            className="inline-flex items-center rounded-md border border-emerald-400/60 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onInput={emit}
        onBlur={emit}
        onKeyDown={onKeyDown}
        data-placeholder={placeholder ?? ""}
        style={{ minHeight }}
        className="token-editor w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring whitespace-pre-wrap break-words"
      />
      <style jsx>{`
        .token-editor:empty::before {
          content: attr(data-placeholder);
          color: hsl(var(--muted-foreground) / 0.6);
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

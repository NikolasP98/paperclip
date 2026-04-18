import { useState } from "react";

interface Props {
  agentId: string;
  chainLength: number;
  activeIndex: number;
  onChange?: (newIndex: number) => void;
}

/**
 * Inline dropdown that lets a user manually move an agent to any level of its
 * fallback chain (or revert from a sticky fallback level back to primary).
 * Hits PATCH /api/agents/:id/active-adapter.
 */
export function RevertAdapterMenu({ agentId, chainLength, activeIndex, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const setActive = async (index: number) => {
    if (index === activeIndex) {
      setOpen(false);
      return;
    }
    setPending(index);
    try {
      await fetch(`/api/agents/${agentId}/active-adapter`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeAdapterIndex: index }),
      });
      onChange?.(index);
    } finally {
      setPending(null);
      setOpen(false);
    }
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-zinc-300 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        L{activeIndex}/{chainLength - 1}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-[12rem] rounded border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {Array.from({ length: chainLength }).map((_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setActive(idx)}
              disabled={idx === activeIndex || pending != null}
              className="block w-full px-3 py-1 text-left text-xs hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
            >
              {idx === activeIndex ? "✓ " : ""}
              Use level {idx} {idx === 0 ? "(primary)" : `(fallback ${idx})`}
              {pending === idx && " …"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

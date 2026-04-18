import clsx from "clsx";

export interface ChainLevel {
  type: string;
  model?: string;
}

export interface AdapterChainBadgeProps {
  chain: ChainLevel[];
  activeLevel: number;
  modelLabel?: string;
  fallbackReason?: string | null;
}

const REASON_LABELS: Record<string, string> = {
  quota_exhausted: "quota exhausted",
  credit_cap_hit: "credit cap hit",
  previous_level_failed: "previous level failed",
};

/**
 * Render an agent's adapter fallback chain as a horizontal sequence of chips.
 * Crossed levels (those the dispatcher walked past) render struck-through and grayed;
 * the active level is highlighted and shows its model label. Failed levels' models
 * are intentionally omitted to keep the surface focused on the effective harness.
 */
export function AdapterChainBadge({
  chain,
  activeLevel,
  modelLabel,
  fallbackReason,
}: AdapterChainBadgeProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
      {chain.map((level, idx) => {
        const isActive = idx === activeLevel;
        const isCrossed = idx < activeLevel;
        return (
          <div key={idx} className="flex items-center gap-1">
            <span
              data-testid={`chain-level-${idx}`}
              className={clsx(
                "rounded px-2 py-0.5 uppercase tracking-wide text-xs",
                isActive &&
                  "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
                isCrossed &&
                  "bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500",
              )}
            >
              {level.type}
            </span>
            {isActive && modelLabel && (
              <span className="text-zinc-700 dark:text-zinc-300">{modelLabel}</span>
            )}
            {idx < chain.length - 1 && (
              <span className="text-zinc-400">
                {idx < activeLevel
                  ? `↓ ${REASON_LABELS[fallbackReason ?? ""] ?? "→"}`
                  : "·"}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

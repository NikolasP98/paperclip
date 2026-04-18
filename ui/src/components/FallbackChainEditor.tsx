import { useState } from "react";

export interface FallbackLevel {
  type: string;
  model: string;
  envAlias?: Record<string, string>;
}

interface Props {
  value: FallbackLevel[];
  onChange: (levels: FallbackLevel[]) => void;
}

/**
 * Per-agent fallback chain editor. Renders the levels stacked, with a
 * "populate defaults" affordance for empty chains. Designed to drop into
 * AgentConfigForm as a collapsible section.
 *
 * Defaults match the spec's tier table — secondary uses sonnet (50$/mo cap),
 * tertiary uses haiku ($20/mo cap). Production deployments configure the
 * matching env aliases via Infisical (OPENROUTER_FALLBACK_API_KEY,
 * OPENROUTER_TERTIARY_API_KEY).
 */

const DEFAULT_SECONDARY: FallbackLevel = {
  type: "pi_local",
  model: "openrouter/anthropic/claude-sonnet-4.5",
  envAlias: { OPENROUTER_API_KEY: "OPENROUTER_FALLBACK_API_KEY" },
};

const DEFAULT_TERTIARY: FallbackLevel = {
  type: "pi_local",
  model: "openrouter/anthropic/claude-haiku-4.5",
  envAlias: { OPENROUTER_API_KEY: "OPENROUTER_TERTIARY_API_KEY" },
};

export function FallbackChainEditor({ value, onChange }: Props) {
  const populateDefaults = () => onChange([DEFAULT_SECONDARY, DEFAULT_TERTIARY]);
  const updateLevel = (idx: number, patch: Partial<FallbackLevel>) =>
    onChange(value.map((lv, i) => (i === idx ? { ...lv, ...patch } : lv)));
  const removeLevel = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <button
          type="button"
          onClick={populateDefaults}
          className="rounded border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700"
        >
          Populate default fallback chain (sonnet $50 → haiku $20)
        </button>
      ) : (
        <>
          {value.map((level, idx) => (
            <div
              key={idx}
              className="rounded border border-zinc-200 p-2 dark:border-zinc-700"
            >
              <div className="mb-1 text-xs uppercase text-zinc-500">
                Fallback level {idx + 1}
              </div>
              <input
                className="block w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                value={level.model}
                onChange={(e) => updateLevel(idx, { model: e.target.value })}
                placeholder="openrouter/anthropic/claude-sonnet-4.5"
              />
              <div className="mt-1 text-xs text-zinc-500">
                Uses key alias: {level.envAlias?.OPENROUTER_API_KEY ?? "(none)"}
              </div>
              <button
                type="button"
                onClick={() => removeLevel(idx)}
                className="mt-1 text-xs text-red-600 hover:underline"
              >
                Remove level {idx + 1}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

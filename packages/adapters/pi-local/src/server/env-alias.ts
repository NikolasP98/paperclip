/**
 * Map a destination env var to take the value of a source env var.
 * Used so pi-local at fallback levels can use OPENROUTER_FALLBACK_API_KEY
 * (or _TERTIARY_) without overwriting the global OPENROUTER_API_KEY in
 * the parent process.
 *
 * Aliases are ONE-WAY: { dest: source } means dest gets source's value.
 * Source keys missing from env are silent no-ops.
 */
export function applyEnvAlias(
  env: Record<string, string>,
  alias: Record<string, string> | undefined,
): Record<string, string> {
  if (!alias || Object.keys(alias).length === 0) return env;
  const out = { ...env };
  for (const [dest, source] of Object.entries(alias)) {
    const sourceValue = env[source];
    if (typeof sourceValue === "string" && sourceValue.length > 0) {
      out[dest] = sourceValue;
    }
  }
  return out;
}

import type { ServiceVersion } from "./constants.js";

const TEMPLATE_SECTION_RE = /###\s*Services\s*\n((?:\s*-\s*.+\n?)+)/i;
const TEMPLATE_LINE_RE = /^\s*-\s*([^:]+):\s*(.+)$/;

function findRepo(
  name: string,
  repoMap: Record<string, string>,
): { key: string; value: string } | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(repoMap)) {
    if (key.toLowerCase() === lower) return { key, value };
  }
  return null;
}

function parseTemplate(body: string, repoMap: Record<string, string>): ServiceVersion[] | null {
  const sectionMatch = body.match(TEMPLATE_SECTION_RE);
  if (!sectionMatch) return null;

  const lines = sectionMatch[1].trim().split("\n");
  const results: ServiceVersion[] = [];

  for (const line of lines) {
    const match = line.match(TEMPLATE_LINE_RE);
    if (!match) continue;

    const serviceName = match[1].trim();
    const version = match[2].trim();
    const repo = findRepo(serviceName, repoMap);
    if (repo) {
      results.push({ serviceName: repo.key, version, repo: repo.value });
    }
  }

  return results.length > 0 ? results : null;
}

function parseRegex(body: string, repoMap: Record<string, string>): ServiceVersion[] {
  const results: ServiceVersion[] = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(repoMap)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${escaped}\\s+(v[.\\w-]+)`, "gi");
    const match = re.exec(body);
    if (match && !seen.has(key)) {
      seen.add(key);
      results.push({ serviceName: key, version: match[1], repo: value });
    }
  }

  return results;
}

export function parseVersions(body: string, repoMap: Record<string, string>): ServiceVersion[] {
  if (!body.trim()) return [];
  const templateResult = parseTemplate(body, repoMap);
  if (templateResult) return templateResult;
  return parseRegex(body, repoMap);
}

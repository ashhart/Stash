import type { Session } from "../types";

export interface SearchableSession {
  session: Session;
  /** Display name of the project (registered name if any, else basename). */
  project: string;
  /** Lowercased blob we match the query against (project + dir + title + any
   *  pre-loaded prompt snippets). Built once at search-prompt boot time. */
  haystack: string;
}

export interface ScoredMatch {
  item: SearchableSession;
  score: number;
}

/**
 * Token-AND substring match with a small scoring kicker for early/contiguous
 * hits. Intentionally simple — fzf-grade ranking adds bytes for not much
 * benefit at this scale.
 */
export function score(query: string, haystack: string): number {
  if (!query) return 1; // no query → keep everything, sort stable
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  let total = 0;
  for (const tok of tokens) {
    const idx = haystack.indexOf(tok);
    if (idx === -1) return 0; // any missing token disqualifies
    // Earlier matches and longer tokens score higher; cap so a 30-char token
    // doesn't dominate.
    const lenWeight = Math.min(tok.length, 12);
    const posWeight = 1 / (1 + idx);
    total += lenWeight + posWeight;
  }
  return total;
}

export function search(
  items: SearchableSession[],
  query: string,
  limit?: number,
): SearchableSession[] {
  if (!query.trim()) {
    return limit !== undefined ? items.slice(0, limit) : items.slice();
  }
  const scored: ScoredMatch[] = [];
  for (const item of items) {
    const s = score(query, item.haystack);
    if (s > 0) scored.push({ item, score: s });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break by recency so similar matches stay newest-first.
    return b.item.session.updatedAt - a.item.session.updatedAt;
  });
  const out = scored.map((s) => s.item);
  return limit !== undefined ? out.slice(0, limit) : out;
}

export function buildSearchable(
  session: Session,
  project: string,
  promptSnippet: string | null,
): SearchableSession {
  const parts = [
    project,
    session.directory,
    session.title,
    session.tool,
    promptSnippet ?? "",
  ];
  return {
    session,
    project,
    haystack: parts.join(" ").toLowerCase(),
  };
}

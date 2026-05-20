import { Prompt, isCancel } from "@clack/core";
import pc from "picocolors";
import { search, type SearchableSession } from "./match";
import { firstPromptSnippet } from "./snippet";
import { previewSession, shortenForPreview, type SessionPreview } from "../preview";
import { dim, formatTokens, tildeify, timeAgo, toolBadge, truncate } from "../format";
import type { Session } from "../types";

const BAR = pc.gray("│");
const BAR_ACTIVE = pc.cyan("│");
const ACTIVE = pc.green("▸");
const INACTIVE = " ";

export interface SearchResult {
  session: Session;
  project: string;
}

interface SearchPromptOptions {
  items: SearchableSession[];
  initialQuery?: string;
  /** how many rows to show in the results list */
  maxRows?: number;
}

/**
 * Live-filtered fuzzy search over every session across every tool. Layout:
 *   query input
 *   ─ results (top N matches) ─
 *   ─ preview (focused row's last user + last assistant) ─
 *   help footer
 *
 * Returns the picked SearchResult, or a clack cancel symbol on Ctrl-C.
 */
class SearchPrompt extends Prompt {
  query = "";
  cursor = 0;
  filtered: SearchableSession[] = [];
  // Memoised previews keyed by `${tool}:${id}`. We hydrate on demand as the
  // cursor moves so we never block typing on disk I/O.
  previewCache = new Map<string, SessionPreview>();
  previewLoading = new Set<string>();
  // Limit how many rows we render at once — keeps the screen size bounded
  // even when 80 sessions match.
  readonly maxRows: number;
  private items: SearchableSession[];

  constructor(opts: SearchPromptOptions) {
    super(
      {
        // The base class calls our `buildFrame()` once per render.
        render: function (this: SearchPrompt) {
          return this.buildFrame();
        },
      },
      false,
    );
    this.items = opts.items;
    this.query = opts.initialQuery ?? "";
    this.maxRows = opts.maxRows ?? 10;
    this.recomputeFiltered();

    this.on("key", (char: string) => this.handleKey(char));
    this.on("cursor", (dir: string) => this.handleCursor(dir));
  }

  private recomputeFiltered() {
    this.filtered = search(this.items, this.query, 200);
    if (this.cursor >= this.filtered.length) {
      this.cursor = Math.max(0, this.filtered.length - 1);
    }
  }

  private handleKey(char: string) {
    if (!char) return;
    const code = char.charCodeAt(0);
    // Filter out anything that's an ANSI escape or non-printable. Cursor
    // events (up/down/enter/space) are routed via the "cursor" channel by
    // the base Prompt class, so they don't show up here as printable chars.
    if (code === 0x1b) return; // ESC
    if (code === 0x7f || code === 0x08) {
      // backspace
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
        this.recomputeFiltered();
        this.kickPreview();
      }
      return;
    }
    if (code < 0x20) return; // ignore control chars
    // Char comes in lowercased from clack's keypress handler; that's fine
    // because we lowercase the haystack too.
    this.query += char;
    this.cursor = 0;
    this.recomputeFiltered();
    this.kickPreview();
  }

  private handleCursor(dir: string) {
    if (this.filtered.length === 0) return;
    if (dir === "up") {
      this.cursor =
        this.cursor === 0 ? this.filtered.length - 1 : this.cursor - 1;
      this.kickPreview();
    } else if (dir === "down") {
      this.cursor =
        this.cursor === this.filtered.length - 1 ? 0 : this.cursor + 1;
      this.kickPreview();
    }
    // SPACE on a row is meaningless here — the user is typing. We let it
    // fall through to handleKey via the "key" channel which adds it to the
    // query.
  }

  /** Hydrate the focused row's preview in the background if we haven't
   *  loaded it yet. Re-renders on completion. */
  private kickPreview() {
    const top = this.filtered[this.cursor];
    if (!top) return;
    const key = `${top.session.tool}:${top.session.id}`;
    if (this.previewCache.has(key)) return;
    if (this.previewLoading.has(key)) return;
    this.previewLoading.add(key);
    previewSession(top.session)
      .then((p) => {
        this.previewCache.set(key, p);
        this.previewLoading.delete(key);
        this.forceRender();
      })
      .catch(() => {
        this.previewLoading.delete(key);
      });
  }

  /** Trigger a re-render outside of a keypress (e.g. when an async preview
   *  load completes). The base class's `render()` method is private, so we
   *  reach in by name. */
  private forceRender(): void {
    const r = (this as unknown as { render?: () => void }).render;
    if (typeof r === "function") r.call(this);
  }

  /** Compose the visible frame. Called by the base class on every keypress
   *  and (via {@link forceRender}) when an async preview lands. */
  buildFrame(): string {
    const lines: string[] = [];
    lines.push(BAR);

    // Header / query line.
    const queryDisplay =
      pc.cyan("›") +
      " " +
      (this.query || pc.dim("type to filter…")) +
      pc.dim(pc.inverse("_"));
    const stateIcon =
      this.state === "submit"
        ? pc.green("◇")
        : this.state === "cancel"
          ? pc.red("■")
          : pc.cyan("◆");
    lines.push(`${stateIcon}  ${pc.bold("stash search")}   ${dim(queryDisplay)}`);
    lines.push(BAR);

    // Results header + rows.
    const total = this.filtered.length;
    const shown = Math.min(total, this.maxRows);
    lines.push(
      `${BAR_ACTIVE}  ${dim(
        `─ results (${total === 0 ? "none" : `${shown}/${total}`}) ──`,
      )}`,
    );
    if (total === 0) {
      lines.push(`${BAR_ACTIVE}  ${dim("(no matches)")}`);
    } else {
      // Window the list around the cursor so the focused row stays visible.
      let start = 0;
      if (this.cursor >= this.maxRows - 2) {
        start = Math.min(
          this.cursor - Math.floor(this.maxRows / 2),
          total - this.maxRows,
        );
        start = Math.max(0, start);
      }
      for (let i = 0; i < shown; i++) {
        const idx = start + i;
        const item = this.filtered[idx];
        if (!item) continue;
        const focused = idx === this.cursor;
        const marker = focused ? ACTIVE : INACTIVE;
        const projectStr = truncate(item.project, 16).padEnd(16);
        const titleStr = truncate(item.session.title, 50);
        const meta = `${timeAgo(item.session.updatedAt)}`;
        const row = `${marker} ${toolBadge(item.session.tool)}  ${pc.bold(projectStr)}  ${titleStr}`;
        const dimmedRow = focused ? row : pc.dim(row);
        lines.push(`${BAR_ACTIVE}  ${dimmedRow}  ${dim(meta)}`);
      }
    }

    // Preview pane.
    lines.push(`${BAR_ACTIVE}  ${dim("─ preview ─────────────────")}`);
    const top = this.filtered[this.cursor];
    if (!top) {
      lines.push(`${BAR_ACTIVE}  ${dim("(no session focused)")}`);
    } else {
      const key = `${top.session.tool}:${top.session.id}`;
      const preview = this.previewCache.get(key);
      if (!preview) {
        lines.push(`${BAR_ACTIVE}  ${dim("loading…")}`);
      } else {
        const statsBits: string[] = [];
        if (preview.messageCount !== null) {
          statsBits.push(`${preview.messageCount} msgs`);
        }
        if (preview.totalTokens !== null) {
          statsBits.push(`~${formatTokens(preview.totalTokens)} tok`);
        }
        statsBits.push(tildeify(top.session.directory));
        lines.push(`${BAR_ACTIVE}  ${dim(statsBits.join("  ·  "))}`);
        lines.push(BAR_ACTIVE);
        const prefixed = (label: string, text: string): string[] => {
          const lines = shortenForPreview(text, 3, 220).split("\n");
          const out: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            const body = i === 0 ? pc.bold(label) + lines[i] : "       " + lines[i];
            out.push(`${BAR_ACTIVE}  ${body}`);
          }
          return out;
        };
        if (preview.lastUser) {
          lines.push(...prefixed("you: ", preview.lastUser));
        }
        if (preview.lastAssistant) {
          if (preview.lastUser) lines.push(BAR_ACTIVE);
          lines.push(...prefixed(top.session.tool + ": ", preview.lastAssistant));
        }
        if (!preview.lastUser && !preview.lastAssistant) {
          lines.push(`${BAR_ACTIVE}  ${dim("(no message content yet)")}`);
        }
      }
    }

    // Footer.
    lines.push(BAR_ACTIVE);
    lines.push(
      `${BAR_ACTIVE}  ${dim("type to filter · ↑↓ navigate · enter resume · ctrl+c exit")}`,
    );
    lines.push(pc.gray("└"));

    return lines.join("\n");
  }
}

export async function runSearchPrompt(
  items: SearchableSession[],
  opts?: { initialQuery?: string },
): Promise<SearchResult | symbol> {
  // Sort items by recency so the empty-query state shows newest first.
  const sorted = items
    .slice()
    .sort((a, b) => b.session.updatedAt - a.session.updatedAt);

  const prompt = new SearchPrompt({
    items: sorted,
    initialQuery: opts?.initialQuery,
  });

  // Surface the focused row as `value` so the base class returns it on
  // submit. We update this on every render via a getter pattern.
  Object.defineProperty(prompt, "value", {
    get() {
      const top = prompt.filtered[prompt.cursor];
      if (!top) return undefined;
      return { session: top.session, project: top.project };
    },
    configurable: true,
  });

  // Build initial previews for the rows visible right now (i.e. the top of
  // the *filtered* list after the initial query, not just the most-recent
  // items overall). That keeps the preview pane populated on open.
  const forceRender = () => {
    const r = (prompt as unknown as { render?: () => void }).render;
    if (typeof r === "function") r.call(prompt);
  };
  const initialVisible = prompt.filtered.slice(0, 3);
  for (const item of initialVisible) {
    const key = `${item.session.tool}:${item.session.id}`;
    if (prompt.previewCache.has(key)) continue;
    previewSession(item.session)
      .then((p) => {
        prompt.previewCache.set(key, p);
        forceRender();
      })
      .catch(() => {});
  }

  const result = await prompt.prompt();
  if (isCancel(result)) return result;
  return result as unknown as SearchResult;
}

/** Build the full searchable index — discovers sessions, hydrates first
 *  user prompts, returns SearchableSessions ready for the prompt. */
export async function buildIndex(
  groups: { directory: string; sessions: Session[]; registered: { name: string } | null }[],
): Promise<SearchableSession[]> {
  const { buildSearchable } = await import("./match");
  const { basename } = await import("node:path");

  // Flatten + tag each session with its project's display name.
  const flat: { session: Session; project: string }[] = [];
  for (const g of groups) {
    const project =
      g.registered?.name ?? basename(g.directory) ?? g.directory;
    for (const s of g.sessions) flat.push({ session: s, project });
  }

  // Read first user prompt for each session in parallel — bounded by file
  // I/O. On a 100-session corpus this is ~60ms.
  const snippets = await Promise.all(
    flat.map(({ session }) => firstPromptSnippet(session)),
  );

  return flat.map(({ session, project }, i) =>
    buildSearchable(session, project, snippets[i] ?? null),
  );
}

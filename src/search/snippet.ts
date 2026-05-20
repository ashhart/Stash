import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Session } from "../types";

const HEAD_BYTES = 32 * 1024;
const MAX_LEN = 800;

/** Pull a short snippet of the *first* user prompt from a session, capped
 *  at MAX_LEN. Used to enrich the search haystack so content queries hit. */
export async function firstPromptSnippet(s: Session): Promise<string | null> {
  try {
    switch (s.tool) {
      case "claude":
        return await firstClaude(s);
      case "codex":
        return await firstCodex(s);
      case "opencode":
        return await firstOpencode(s);
    }
  } catch {
    return null;
  }
}

function clean(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_LEN ? cleaned.slice(0, MAX_LEN) : cleaned;
}

function looksLikeMeta(text: string): boolean {
  return (
    text.startsWith("<command-name>") ||
    text.startsWith("<local-command") ||
    text.startsWith("<system-reminder")
  );
}

async function firstClaude(s: Session): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  // Walk the project dirs once to find the session file.
  const dirs = await readdir(root).catch(() => []);
  let file: string | null = null;
  for (const d of dirs) {
    const full = join(root, d, `${s.id}.jsonl`);
    if (existsSync(full)) {
      file = full;
      break;
    }
  }
  if (!file) return null;
  const f = Bun.file(file);
  const head = await f.slice(0, Math.min(f.size, HEAD_BYTES)).text();
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const o = JSON.parse(line);
      if (o?.type !== "user" || o.isMeta) continue;
      const text = extractClaude(o.message);
      if (text && !looksLikeMeta(text)) return clean(text);
    } catch {
      // ignore
    }
  }
  return null;
}

function extractClaude(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { content?: unknown };
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const item of c) {
      if (item && typeof item === "object") {
        const it = item as { type?: string; text?: string };
        if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
      }
    }
    return parts.join("\n") || null;
  }
  return null;
}

async function firstCodex(s: Session): Promise<string | null> {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  const file = await locateCodex(root, s.id);
  if (!file) return null;
  const f = Bun.file(file);
  const head = await f.slice(0, Math.min(f.size, HEAD_BYTES)).text();
  for (const line of head.split("\n")) {
    if (!line.includes('"response_item"') || !line.includes('"role":"user"')) continue;
    try {
      const o = JSON.parse(line);
      if (o?.type !== "response_item") continue;
      const p = o.payload;
      if (!p || p.type !== "message" || p.role !== "user") continue;
      const text = extractCodex(p.content);
      if (text && !looksLikeMeta(text)) return clean(text);
    } catch {
      // ignore
    }
  }
  return null;
}

function extractCodex(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        const it = item as { type?: string; text?: string };
        if ((it.type === "input_text" || it.type === "output_text" || it.type === "text") &&
            typeof it.text === "string") {
          parts.push(it.text);
        }
      }
    }
    return parts.join("\n") || null;
  }
  return null;
}

async function locateCodex(root: string, id: string): Promise<string | null> {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) queue.push(full);
      else if (st.isFile() && entry.endsWith(`-${id}.jsonl`)) return full;
    }
  }
  return null;
}

async function firstOpencode(s: Session): Promise<string | null> {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    // Find the first user message for this session, then concatenate its
    // text parts.
    const msg = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM message
         WHERE session_id = ?
           AND json_extract(data, '$.role') = 'user'
         ORDER BY time_created ASC
         LIMIT 1`,
      )
      .get(s.id);
    if (!msg) return null;
    const parts = db
      .query<{ data: string }, [string]>(
        `SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC`,
      )
      .all(msg.id);
    const text = parts
      .map((p) => {
        try {
          const d = JSON.parse(p.data);
          return d?.type === "text" && typeof d.text === "string" ? d.text : "";
        } catch {
          return "";
        }
      })
      .join("\n")
      .trim();
    if (!text || looksLikeMeta(text)) return null;
    return clean(text);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

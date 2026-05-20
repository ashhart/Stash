import pc from "picocolors";
import * as p from "@clack/prompts";
import { discoverAll } from "../discover";
import { loadRegistry, recordLastSession, saveRegistry } from "../registry";
import { buildIndex, runSearchPrompt, type SearchResult } from "./prompt";
import {
  buildCommand,
  launch,
  shellJoin,
  toolSupportsSkipPermissions,
} from "../launch";
import type { LaunchOptions } from "../types";
import { dim, tildeify } from "../format";
import { printLogo } from "../logo";

export interface RunSearchOptions {
  initialQuery?: string;
  skipPermissions: boolean;
  newWindow: boolean;
  dryRun: boolean;
  here: boolean;
}

export async function runSearch(opts: RunSearchOptions): Promise<number> {
  console.clear();
  printLogo();
  p.intro(pc.bgMagenta(pc.black(" stash ")) + dim("  search across tools"));

  const registry = await loadRegistry();
  const state = await discoverAll(registry.projects);

  const sp = p.spinner();
  sp.start("indexing sessions…");
  const items = await buildIndex(state.allGroups);
  sp.stop(`indexed ${items.length} sessions across all three tools.`);

  if (items.length === 0) {
    p.note(
      "No claude / codex / opencode sessions found yet.",
      "Nothing to search",
    );
    return 0;
  }

  const picked = await runSearchPrompt(items, {
    initialQuery: opts.initialQuery,
  });
  if (typeof picked === "symbol" || !picked) {
    p.cancel("Cancelled.");
    return 1;
  }

  const result = picked as SearchResult;

  const launchOpts: LaunchOptions = {
    tool: result.session.tool,
    dir: result.session.directory,
    sessionId: result.session.id,
    skipPermissions:
      opts.skipPermissions && toolSupportsSkipPermissions(result.session.tool),
    newWindow: opts.here ? false : opts.newWindow,
  };

  // Confirm preview before launch — matches the picker UX.
  const cmd = shellJoin(buildCommand(launchOpts));
  p.note(
    `${dim("cd")} ${tildeify(result.session.directory)}\n${cmd}`,
    launchOpts.newWindow ? "Will run in new terminal" : "Will run here",
  );

  if (opts.dryRun) {
    return 0;
  }

  // Persist last-used for the matching registered project, if any.
  const reg = registry.projects.find(
    (p) => p.dir === result.session.directory,
  );
  if (reg) {
    recordLastSession(
      registry,
      result.session.directory,
      result.session.tool,
      result.session.id,
    );
    await saveRegistry(registry);
  }

  const launchResult = await launch(launchOpts);
  if (launchOpts.newWindow) {
    console.log(dim(`stash: ${launchResult.plan.description}`));
  }
  return 0;
}

import { basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import pc from "picocolors";
import {
  ALL_TOOLS,
  type LaunchOptions,
  type RegisteredProject,
  type Tool,
} from "./types";
import {
  findByName,
  loadRegistry,
  recordLastSession,
  removeProject,
  saveRegistry,
  upsertProject,
  REGISTRY_PATH,
} from "./registry";
import { discoverAll } from "./discover";
import { buildCommand, launch, shellJoin, toolSupportsSkipPermissions } from "./launch";
import { runInteractive } from "./tui";
import { dim, tildeify, timeAgo, toolBadge } from "./format";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "yolo",
  "here",
  "new-window",
  "new",
  "fresh",
  "dry-run",
  "skip-permissions",
]);

const VALUE_FLAGS = new Set([
  "tool",
  "session",
  "dir",
  "name",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice();
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = "";

  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--") {
      positional.push(...args);
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = args[0];
        const wantsValue =
          VALUE_FLAGS.has(key) || (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("-"));
        if (wantsValue && next !== undefined && !next.startsWith("-")) {
          flags[key] = args.shift()!;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) flags[ch] = true;
      continue;
    }
    if (!command) {
      command = a;
    } else {
      positional.push(a);
    }
  }

  return { command, positional, flags };
}

export async function runCli(rawArgs: string[]): Promise<number> {
  const args = parseArgs(rawArgs);

  if (args.flags["help"] || args.flags["h"] === true || args.command === "help") {
    printHelp();
    return 0;
  }
  if (args.flags["version"] || args.flags["V"]) {
    const { version } = await import("../package.json");
    console.log(`stash ${version}`);
    return 0;
  }

  // `stash <name>`: resume the registered project by name (or first-letter
  // match). Distinguished from subcommands by checking the reserved list.
  const reserved = new Set([
    "",
    "add",
    "new",
    "ls",
    "list",
    "rm",
    "remove",
    "del",
    "delete",
    "where",
    "path",
    "edit",
    "help",
    "doctor",
    "check",
    "search",
    "s",
    "find",
  ]);

  if (!reserved.has(args.command)) {
    return await runResumeByName(args.command, args);
  }

  switch (args.command) {
    case "":
      return await runInteractiveCommand(args);
    case "add":
    case "new":
      return await runAdd(args);
    case "ls":
    case "list":
      return await runList(args);
    case "rm":
    case "remove":
    case "del":
    case "delete":
      return await runRemove(args);
    case "where":
    case "path":
      console.log(REGISTRY_PATH);
      return 0;
    case "edit":
      return await runEdit();
    case "doctor":
    case "check":
      return await (await import("./doctor")).runDoctor();
    case "search":
    case "s":
    case "find":
      return await runSearchCommand(args);
    default:
      printHelp();
      return 1;
  }
}

function flagBool(args: ParsedArgs, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    if (k in args.flags) {
      const v = args.flags[k];
      return v === true || v === "true" || v === "1" || v === "yes";
    }
  }
  return undefined;
}

async function runSearchCommand(args: ParsedArgs): Promise<number> {
  const { runSearch } = await import("./search");
  const initialQuery = args.positional.join(" ").trim() || undefined;
  const skipPermissions = flagBool(args, "yolo", "y", "skip-permissions") ?? false;
  const newWindow =
    flagBool(args, "new-window", "w") ??
    (flagBool(args, "here") === true ? false : undefined) ??
    true;
  const here = flagBool(args, "here") === true;
  const dryRun = flagBool(args, "dry-run", "n") === true;
  return await runSearch({
    initialQuery,
    skipPermissions,
    newWindow,
    here,
    dryRun,
  });
}

async function runInteractiveCommand(args: ParsedArgs): Promise<number> {
  const skipPermissions = flagBool(args, "yolo", "y", "skip-permissions") ?? false;
  const newWindow =
    flagBool(args, "new-window", "w") ??
    (flagBool(args, "here") === true ? false : undefined) ??
    true;

  const opts = await runInteractive({ skipPermissions, newWindow });
  if (!opts) return 1;
  const result = await launch(opts);
  if (opts.newWindow) {
    console.log(dim(`stash: ${result.plan.description}`));
  }
  return 0;
}

async function runResumeByName(
  name: string,
  args: ParsedArgs,
): Promise<number> {
  const registry = await loadRegistry();
  const proj = findByName(registry, name);
  if (!proj) {
    console.error(
      `stash: no registered project matches "${name}".\n` +
        `       Run \`stash\` to see the picker, or \`stash add\` to register one.`,
    );
    return 1;
  }

  const tool = (args.flags["tool"] as Tool | undefined) ?? proj.lastTool ?? proj.defaultTool;
  if (!ALL_TOOLS.includes(tool)) {
    console.error(`stash: unknown tool "${tool}"`);
    return 1;
  }

  let sessionId: string | null = null;
  const explicitSession = args.flags["session"];
  const newFlag = flagBool(args, "new", "fresh") ?? false;
  if (typeof explicitSession === "string") {
    sessionId = explicitSession;
  } else if (!newFlag) {
    sessionId = await resolveMostRecentSession(proj, tool);
  }

  const skipPermissions =
    flagBool(args, "yolo", "y", "skip-permissions") ?? proj.skipPermissions;
  const newWindow =
    flagBool(args, "new-window", "w") ??
    (flagBool(args, "here") === true ? false : undefined) ??
    proj.newWindow;

  const opts: LaunchOptions = {
    tool,
    dir: proj.dir,
    sessionId,
    skipPermissions: skipPermissions && toolSupportsSkipPermissions(tool),
    newWindow,
  };

  if (flagBool(args, "dry-run", "n")) {
    console.log(`cd ${tildeify(proj.dir)}`);
    console.log(shellJoin(buildCommand(opts)));
    return 0;
  }

  recordLastSession(registry, proj.dir, tool, sessionId);
  await saveRegistry(registry);

  const result = await launch(opts);
  if (opts.newWindow) {
    console.log(dim(`stash: ${result.plan.description}`));
  }
  return 0;
}

async function resolveMostRecentSession(
  proj: RegisteredProject,
  tool: Tool,
): Promise<string | null> {
  // Prefer the project's last-used session for that tool when present.
  if (proj.lastTool === tool && proj.lastSessionId) return proj.lastSessionId;

  const { groups } = await discoverAll([proj]);
  const group = groups.find((g) => g.directory === proj.dir);
  if (!group) return null;
  const recent = group.sessions.filter((s) => s.tool === tool)[0];
  return recent ? recent.id : null;
}

async function runAdd(args: ParsedArgs): Promise<number> {
  const registry = await loadRegistry();

  const dir =
    (args.flags["dir"] as string | undefined) ??
    args.positional[0] ??
    process.cwd();

  const resolved = dir.startsWith("/")
    ? dir
    : require("node:path").resolve(process.cwd(), dir);

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    console.error(`stash: not a directory: ${resolved}`);
    return 1;
  }

  // Non-interactive `stash add <dir> --name foo --tool claude` path.
  const name = (args.flags["name"] as string | undefined) ?? basename(resolved);
  const tool = (args.flags["tool"] as Tool | undefined) ?? "claude";
  if (!ALL_TOOLS.includes(tool)) {
    console.error(`stash: unknown tool "${tool}"`);
    return 1;
  }
  const skipPermissions = flagBool(args, "yolo", "y", "skip-permissions") ?? false;
  const newWindow =
    flagBool(args, "new-window", "w") ??
    (flagBool(args, "here") === true ? false : undefined) ??
    true;

  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error(
      `stash: invalid name "${name}" (use letters, numbers, dot, dash, underscore)`,
    );
    return 1;
  }

  const project = upsertProject(registry, {
    name,
    dir: resolved,
    defaultTool: tool,
    skipPermissions,
    newWindow,
  });
  await saveRegistry(registry);
  console.log(
    `${pc.green("✓")} ${pc.bold(project.name)} → ${tildeify(project.dir)}  ${dim(
      `[${tool}${skipPermissions ? ", skip-perm" : ""}${newWindow ? ", new-window" : ""}]`,
    )}`,
  );
  return 0;
}

async function runList(args?: ParsedArgs): Promise<number> {
  const showAll = args ? flagBool(args, "all", "a") ?? false : false;
  const registry = await loadRegistry();
  const state = await discoverAll(registry.projects);
  const groups = showAll ? state.allGroups : state.groups;
  if (groups.length === 0) {
    console.log(dim("No projects found yet."));
    return 0;
  }
  const hidden = state.allGroups.length - state.groups.length;
  for (const g of groups) {
    const star = g.registered ? pc.yellow("★") : " ";
    const name = g.registered ? pc.bold(g.registered.name) : g.displayName;
    const counts = countByTool(g.sessions);
    const detail =
      counts.length === 0
        ? dim("no sessions")
        : counts.map(([t, n]) => `${toolBadge(t)}·${n}`).join("  ");
    const when = g.latest ? timeAgo(g.latest) : "—";
    console.log(`${star} ${name}  ${dim(tildeify(g.directory))}`);
    console.log(`    ${detail}  ${dim(when)}`);
  }
  if (!showAll && hidden > 0) {
    console.log(
      "\n" +
        dim(
          `${hidden} clutter project(s) hidden (cache / Downloads / system dirs). ` +
            `Use \`stash ls --all\` to see them, or \`stash\` and pick "Sweep clutter".`,
        ),
    );
  }
  return 0;
}

function countByTool(sessions: { tool: string }[]): [string, number][] {
  const counts: Record<string, number> = {};
  for (const s of sessions) counts[s.tool] = (counts[s.tool] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

async function runRemove(args: ParsedArgs): Promise<number> {
  const target = args.positional[0];
  if (!target) {
    console.error("stash: usage: stash rm <name>");
    return 1;
  }
  const registry = await loadRegistry();
  if (removeProject(registry, target)) {
    await saveRegistry(registry);
    console.log(`${pc.green("✓")} removed ${target}`);
    return 0;
  }
  console.error(`stash: no registered project named "${target}"`);
  return 1;
}

async function runEdit(): Promise<number> {
  const editor = process.env["EDITOR"] || process.env["VISUAL"] || "vi";
  await new Promise<void>((resolve, reject) => {
    const child = require("node:child_process").spawn(editor, [REGISTRY_PATH], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", () => resolve());
  });
  return 0;
}

function printHelp(): void {
  const lines = [
    `${pc.bold("stash")}  ${dim("resume across claude / codex / opencode")}`,
    "",
    `${pc.bold("USAGE")}`,
    `  stash                          interactive launcher`,
    `  stash ${pc.cyan("<name>")}                   resume registered project by name`,
    `  stash add ${dim("[dir]")} [--name N] [--tool claude|codex|opencode]`,
    `                                  register a project (defaults to cwd)`,
    `  stash ls                       list all known projects`,
    `  stash rm ${pc.cyan("<name>")}                remove a registered project`,
    `  stash where                    print the registry path`,
    `  stash edit                     open the registry in $EDITOR`,
    `  stash doctor                   verify each tool's session format still parses`,
    `  stash search ${dim("[query]")}            fuzzy-search across every session, with preview pane`,
    "",
    `${pc.bold("FLAGS")} ${dim("(work with `stash` and `stash <name>`)")}`,
    `  -y, --yolo                     run with --dangerously-skip-permissions`,
    `      --here                     run in current terminal (no new window)`,
    `  -w, --new-window               force a new terminal window`,
    `      --new                      start a fresh session (don't resume)`,
    `      --tool claude|codex|opencode`,
    `      --session <id>             resume a specific session id`,
    `  -n, --dry-run                  print the command, don't run`,
    "",
    `${pc.bold("FILES")}`,
    `  ${REGISTRY_PATH}`,
  ];
  console.log(lines.join("\n"));
}

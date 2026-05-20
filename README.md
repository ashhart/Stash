```
  ┏━┓╺┳╸┏━┓┏━┓╻ ╻
  ┗━┓ ┃ ┣━┫┗━┓┣━┫
  ┗━┛ ╹ ╹ ╹┗━┛╹ ╹
```

> Have you ever started a CLI project, forgot to note down the resume command,
> then burned a stack of tokens making the agent re-read the repo just to get
> its bearings? Same.

**stash** is an interactive launcher that resumes **claude**, **codex**, and
**opencode** sessions across every project you've ever opened. No more
copy-pasting your "here's where we left off" recap into a fresh chat. No more
hunting through `~/.claude/projects/<encoded-path>/<uuid>.jsonl` for the right
session id. Just `stash`, pick a project, pick the conversation, and the right
tool launches in a new terminal window in the right directory with the right
`--resume <id>` flag already filled in.

```
$ stash
  ┏━┓╺┳╸┏━┓┏━┓╻ ╻
  ┗━┓ ┃ ┣━┫┗━┓┣━┫
  ┗━┛ ╹ ╹ ╹┗━┛╹ ╹
  resume across claude · codex · opencode

┌  stash  resume across tools
│
◆  Pick a project
│  ★ api                       2m ago  [claude·3]
│    web-app                  31m ago  [claude·2, codex·2]
│    deploy-scripts            9h ago  [claude·3, opencode·2]
│    + Register a new project…
│    ✗ Delete a project (purge all sessions)…
│    🧹 Sweep clutter (8 hidden / stale)…
│
│  ↑↓ navigate · enter select · space toggle · ctrl+c exit
└
```

## What it actually solves

- **Lost resume commands.** Every tool has a `--resume <id>` (or equivalent),
  but the id is a UUID buried in a log somewhere. stash finds it for you.
- **Wasted tokens.** Resuming the *right* conversation instead of starting
  fresh means the agent already knows your codebase, decisions, gotchas. No
  more "read the repo, then we'll begin."
- **Three tools, one mental model.** claude / codex / opencode each store
  sessions differently (JSONL files, rollout files + index, a SQLite db).
  stash normalises them into one picker.
- **Multi-project sprawl.** If you bounce between 30 projects like me, you
  forget what's in each one. stash groups every session by project directory
  and tags it with the last AI-generated title.
- **Clutter from accidental invocations.** `cd ~/.cache/huggingface/hub`,
  ran claude once by mistake → it's now a "project" forever. stash hides
  obvious clutter and offers a one-tap **Sweep** to nuke it.

## Install

```bash
brew tap SectorOPS/Stash https://github.com/SectorOPS/Stash
brew install SectorOPS/Stash/stash
```

Or in one shot:

```bash
brew install SectorOPS/Stash/stash
```

> `brew install stash` (unqualified) matches the unrelated **Stash.app** proxy
> tool's cask, not this CLI. Always use the fully-qualified
> `SectorOPS/Stash/stash` form. If you'd previously installed the Cask, you
> may also need `brew link --overwrite stash` after installing ours.

To upgrade:

```bash
brew update && brew upgrade SectorOPS/Stash/stash
```

### Install from source

```bash
git clone https://github.com/SectorOPS/Stash.git
cd Stash
./install.sh
```

Requires [bun](https://bun.sh) (`brew install oven-sh/bun/bun`). The installer
picks the best writable directory on your `$PATH` (`/opt/homebrew/bin` on a
Homebrew Mac, `~/.local/bin` as a fallback) and drops a `stash` symlink there.
`PREFIX=/usr/local ./install.sh` to override.

Works on macOS and Linux. The new-terminal opener detects iTerm2, Terminal.app,
Ghostty, WezTerm, Warp, kitty, Alacritty, gnome-terminal, konsole,
xfce4-terminal, foot, and xterm. If you're already inside tmux it just opens a
new tmux window.

## Usage

### Interactive

```bash
stash                  # the main event — pick project, pick session
```

A typical run:

1. **Project picker.** Every directory where you've ever opened claude/codex/
   opencode, sorted by recency. Registered projects get a ★. Clutter (caches,
   `~/Downloads`, `/tmp`, missing dirs) is hidden by default.
2. **Session menu.** For the picked project: a row per existing session
   (showing the AI-generated title and the exact resume command that'll run),
   plus options to start a fresh session in any of the three tools.
3. **Toggle skip-permissions** (`SPACE` on that row) and **new terminal
   window** (`SPACE` on that row). Save defaults per registered project.
4. **Launch.** Spawns a new terminal window in the project's directory and
   runs the resume command for you.

### Direct

```bash
stash <name>           # resume registered project by name (most recent session, default tool)
stash <name> -y        # …with skip-permissions
stash <name> --new     # start a fresh session in that project's default tool
stash <name> --tool codex
stash <name> --session <uuid>
stash <name> --dry-run # print the command, don't run it
```

### Registry management

```bash
stash add [dir]              # register cwd (or dir) as a project
stash add --name api --tool claude --dir ~/code/api
stash ls                     # list visible projects
stash ls --all               # include hidden clutter
stash rm <name>              # unregister (keeps sessions on disk)
stash where                  # print registry path
stash edit                   # open registry in $EDITOR
```

### Health check

```bash
stash doctor                 # verify each tool's session format still parses
```

Runs a per-tool check that opens one session, looks for the fields stash
depends on, and reports `ok` / `warn` / `error` with a one-line explanation.
Exits non-zero on any error so you can wire it into CI or a shell `precmd`.
Run it after upgrading claude / codex / opencode to catch schema drift early.

## Flags reference

```
-y, --yolo          add --dangerously-skip-permissions  (claude/codex)
    --here          run in current terminal instead of new window
-w, --new-window    force a new window even if default is --here
    --new           start fresh session instead of resuming
    --tool TOOL     override default tool (claude|codex|opencode)
    --session ID    resume a specific session uuid
-n, --dry-run       print the command, don't launch
-a, --all           (with `ls`) include hidden clutter
```

## How it finds sessions

| Tool     | Source                                                              |
| -------- | ------------------------------------------------------------------- |
| claude   | `~/.claude/projects/<encoded-path>/<uuid>.jsonl`                    |
| codex    | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` + `session_index.jsonl` |
| opencode | `~/.local/share/opencode/opencode.db` (SQLite)                      |

Titles come from each tool's own metadata: claude's `ai-title` (falling back to
the last user prompt), codex's `thread_name` in the session index, opencode's
session `title` column.

Token totals are pulled from each tool's own usage tracking and shown where
they're accurate: **claude** records `usage.input_tokens` / `usage.output_tokens`
per assistant turn and **opencode** records `tokens.input` / `tokens.output`
per message — both are summed into the `~Nk tok` you see in the picker.
**codex** doesn't record per-turn usage in its rollouts, so codex rows show
only `N msgs`. The asymmetry is deliberate — better to show a real number
where one exists than to fake it everywhere.

### Tested against

Stash is tested against the following CLI versions. `stash doctor` will tell
you if your install diverges in a way that breaks parsing.

| Tool     | Tested up to | Storage format                  |
| -------- | ------------ | ------------------------------- |
| claude   | 2.1.x        | JSONL with `ai-title`, `last-prompt`, `user`, `assistant` events |
| codex    | 0.129.x      | rollout JSONL with `session_meta` + `response_item` envelopes |
| opencode | 1.14.x       | SQLite schema with `session` / `message` / `part` tables |

The encoded-path scheme claude uses (`/` and `.` both map to `-`) is ambiguous
on decode, so stash walks the real filesystem to disambiguate (e.g. it knows
`-home-user--cache-huggingface-hub` is `~/.cache/huggingface/hub`, not
`~/cache/huggingface/hub`).

## Registry

`~/.config/stash/registry.json` (or `$XDG_CONFIG_HOME/stash/registry.json`):

```json
{
  "version": 1,
  "projects": [
    {
      "name": "api",
      "dir": "/home/you/code/api",
      "defaultTool": "claude",
      "skipPermissions": false,
      "newWindow": true,
      "lastSessionId": "00000000-0000-0000-0000-000000000000",
      "lastTool": "claude",
      "addedAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

`stash edit` opens it in `$EDITOR` if you need to clean it up by hand.

## Skip-permissions mapping

`-y` / `--yolo` translates per-tool:

- **claude**   → `--dangerously-skip-permissions`
- **codex**    → `--dangerously-bypass-approvals-and-sandbox`
- **opencode** → no CLI flag exposed; the option is silently ignored

## Housekeeping

stash gives you three flavours of cleanup, from gentle to scorched-earth:

- **`✂ Delete sessions…`** (inside a project's session menu): multi-select
  checklist · prune duplicates · keep the most-recent N.
- **`✗ Delete a project (purge all sessions)…`** (in the project picker, or
  inside a session menu): nuke every session attached to a project across all
  three tools, plus its registry entry. Asks you to type the project name to
  confirm.
- **`🧹 Sweep clutter…`** (in the project picker, when there's anything to
  sweep): auto-finds sessions in obvious junk paths (`~/.cache`, `~/Downloads`,
  `~/Library`, `/tmp`, `/var`, etc.) and dirs that no longer exist, previews
  exactly what'll be removed, then deletes the lot in one confirm.

The on-disk project directory is never touched — only the session files /
SQLite rows.

## Environment

- `CLAUDE_CODE_SESSION_ID` — when set (it is whenever stash is launched from
  inside an active Claude Code conversation), that session is excluded from
  the picker, since deleting it just gets recreated by the next assistant
  message.
- `NO_BANNER=1` — suppresses the ASCII logo at launch.
- `XDG_CONFIG_HOME` — overrides the default `~/.config` location for the
  registry.

## License

MIT.

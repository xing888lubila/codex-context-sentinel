# codex-context-sentinel

`codex-context-sentinel` is a lightweight local CLI for estimating whether a
Codex conversation has become too expensive to keep carrying forward.

It scans local Codex session files, groups sessions by project path, estimates
context pressure from conversation size and tool activity, and prints a
practical recommendation:

- `continue-current-thread`
- `consider-new-thread`
- `start-new-thread`

It cannot read hidden real-time Codex billing or token counters. It uses local
session files and transparent heuristics, then generates a short handoff prompt
when a new conversation is likely cleaner.

## Why This Exists

Long Codex threads can become less useful when every turn spends more effort
recovering old context than doing current work. This tool gives a local,
repeatable signal for when to start a fresh thread and what to paste into it.

## Install

Clone the repository, then run it directly with Node:

```powershell
git clone https://github.com/xing888lubila/codex-context-sentinel.git
cd codex-context-sentinel
node src/index.js scan --project "G:\文档\New project 2"
```

Or link it locally:

```powershell
npm link
context-sentinel scan --project "G:\文档\New project 2"
```

## Usage

Scan the default Codex sessions directory:

```powershell
context-sentinel scan --project "G:\文档\New project 2"
```

Use a custom sessions directory:

```powershell
context-sentinel scan --project "G:\文档\New project 2" --sessions "C:\Users\ASUS\.codex\sessions"
```

Emit JSON:

```powershell
context-sentinel scan --project "G:\文档\New project 2" --json
```

Install a user-level Codex hook:

```powershell
node src/index.js install-hook --warn-score 55 --block-score 75
```

After installation, restart Codex or open `/hooks` and review/trust the hook.
Codex requires non-managed hooks to be trusted before they run.

When the hook blocks an overlong conversation, start a new Codex thread with
the generated handoff prompt. If you intentionally want to keep going in the
same thread, include this token in your next message:

```text
sentinel-continue
```

## Output

The report includes:

- matched session file count
- estimated total characters and tokens
- user message count
- assistant message count
- tool activity count
- project mention count
- recommendation
- suggested new-thread handoff prompt

## Heuristic

The current score is intentionally simple:

- large estimated token volume increases pressure
- many matched session files increase pressure
- many tool calls increase pressure
- repeated project mentions increase pressure

This is not a billing calculator. It is a practical "should we start fresh?"
signal.

## Current Limits

- Real-time prompting requires Codex clients that load lifecycle hooks from
  `~/.codex/hooks.json` or `~/.codex/config.toml`.
- It does not access private Codex token accounting.
- It only sees local session files available on the current machine.
- It does not modify or delete any Codex files.

## Why Some Codex Interfaces May Not Load The Hook

Codex hooks are a local client feature. A Codex interface may not load
`~/.codex/hooks.json` when:

- it is not backed by the local Codex CLI or IDE configuration layer;
- hooks are disabled in `config.toml` or by managed policy;
- the project or hook has not been reviewed and trusted;
- the client is an older or limited surface that does not support lifecycle
  hooks;
- the session runs remotely where the local Windows `~/.codex` directory is not
  available.

In those cases, use `context-sentinel scan` manually or install the hook in the
environment where that Codex session actually runs.

## Development

Run tests:

```powershell
npm test
```

or:

```powershell
npm run check
```

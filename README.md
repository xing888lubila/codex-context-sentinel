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

- It does not automatically monitor every future Codex thread in real time.
- It does not access private Codex token accounting.
- It only sees local session files available on the current machine.
- It does not modify or delete any Codex files.

## Development

Run tests:

```powershell
npm test
```

or:

```powershell
npm run check
```

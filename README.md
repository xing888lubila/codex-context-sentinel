# codex-context-sentinel

`codex-context-sentinel` is a lightweight local watcher for Codex session
pressure. It scans local Codex session files and recommends whether a project
can continue in the current thread or should move to a fresh conversation.

Recommendations:

- `continue-current-thread`
- `consider-new-thread`
- `start-new-thread`

This is not an exact token billing calculator. Codex does not expose hidden
real-time accounting here, so this tool uses local session files and transparent
heuristics based on file size, matched project sessions, tool activity, and
project mentions.

## Why This Exists

Long Codex threads can become less useful when every turn spends more effort
recovering old context than doing current work. This tool gives a local,
repeatable signal for when to start a fresh thread and what to paste into it.

For the current Codex desktop interface on this Windows machine, the background
watcher is the recommended mode. The older hook mode is retained as an optional
capability, but it is less suitable when `/hooks` shows no commands in the
desktop UI and there is no hook trust flow available.

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

## Background Watcher

Run a foreground watcher:

```powershell
node src/index.js watch --project "G:\文档\New project 2" --interval 300
```

Every interval, the watcher scans `C:\Users\ASUS\.codex\sessions`. By default,
watcher mode analyzes only the most recently modified session file that matches
the project path or project name. This is meant to track the active conversation
for that project instead of being polluted by old, abandoned long conversations.

Use aggregate project mode only when you intentionally want a whole-project
overview:

```powershell
node src/index.js watch --project "G:\文档\New project 2" --scope project
```

When context pressure reaches `consider-new-thread` or `start-new-thread`, it
shows a Windows notification:

```text
Codex 上下文过长，建议开启新对话
```

The notification also includes the project path and recommendation level.
The default visual alert is a small topmost window that stays open for up to
60 seconds and can be closed manually.

The watcher writes handoff files here:

```text
C:\Users\ASUS\.codex\context-sentinel\handoffs\YYYYMMDD-HHMMSS-project.md
```

It also writes status here:

```text
C:\Users\ASUS\.codex\context-sentinel\watcher-state.json
```

To avoid repeated interruptions, the same project and same recommendation level
notify at most once every 30 minutes by default.

Check watcher state:

```powershell
node src/index.js status
```

Stop the PID recorded in the watcher state file:

```powershell
node src/index.js stop
```

Run a single scan/write cycle, useful for testing the watcher path:

```powershell
node src/index.js watch --project "G:\文档\New project 2" --once
```

Send a test notification without waiting for the cooldown window:

```powershell
node src/index.js notify-test --project "G:\文档\New project 2"
```

## Windows Notification Strategy

The watcher uses no npm notification dependency.

On Windows, it writes and launches a small PowerShell Windows Forms popup under
`C:\Users\ASUS\.codex\context-sentinel\show-notification.ps1`. The popup stays
open for up to 60 seconds and can be closed manually. If that display path
fails, it falls back to `New-BurntToastNotification` when BurntToast is already
installed, then to the Windows toast WinRT APIs from PowerShell. If visual
notification display fails, the watcher still writes the status and handoff
files.

Adding an npm dependency such as `node-notifier` would make notification
behavior more uniform but would add install size, native/platform behavior, and
another dependency to maintain. The current default keeps the tool dependency
free.

## Windows Scheduled Task

Install a user logon scheduled task:

```powershell
node src/index.js install-windows-task --project "G:\文档\New project 2" --interval 300
```

The installer writes a short PowerShell launcher under:

```text
C:\Users\ASUS\.codex\context-sentinel\CodexContextSentinel.ps1
```

The scheduled task calls that launcher instead of embedding the full Node
command in `/TR`, because Windows `schtasks` rejects long `/TR` values.

Start it immediately after installation:

```powershell
schtasks /Run /TN CodexContextSentinel
```

If `schtasks` reports `Access is denied`, run the install command from your own
Windows PowerShell session, or from an elevated PowerShell if your local policy
requires it.

Delete the scheduled task later if needed:

```powershell
schtasks /Delete /TN CodexContextSentinel /F
```

## Manual Scan

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

## Optional Hook Mode

Hook mode is retained for Codex clients that support and display lifecycle
hooks. It is optional for this project.

Install a user-level Codex hook:

```powershell
node src/index.js install-hook --warn-score 55 --block-score 75
```

After installation, restart Codex or open `/hooks` and review/trust the hook.
Codex requires non-managed hooks to be trusted before they run. If your desktop
interface shows no commands under `/hooks`, use the watcher mode instead.

Existing hook files are not removed by this tool. To disable the old hook
manually, edit:

```text
C:\Users\ASUS\.codex\hooks.json
```

Remove the `codex-context-sentinel` entry under `UserPromptSubmit`, or move the
file aside after making a backup. If hook support was enabled only for this
experiment, also review:

```text
C:\Users\ASUS\.codex\config.toml
```

and remove or disable the previous `features.hooks` setting if you no longer
want Codex to load hooks. Do not delete these files unless you are sure no other
tooling depends on them.

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

## Development

Run tests:

```powershell
npm test
```

or:

```powershell
npm run check
```

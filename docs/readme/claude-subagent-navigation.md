# Claude subagent navigation

Click a Claude child row in the desktop sidebar or dashboard to open that
subagent's transcript in Claude's terminal view. Click the parent row to return
to the main conversation. The composer draft stays in place.

An eye marks the transcript Claude is displaying. It follows Claude's keyboard
navigation too. When child rows are collapsed, the parent shows the viewed
child's name; the compact group summary keeps the focused agent's indicator.

## Setup

Enable **Settings → Agents → Claude subagent navigation**, keep agent status
hooks enabled, and launch Claude Code 2.1.300 or newer in Orca. This setting is
off by default. It permits Orca to add a shortcut to the selected Claude
config's `keybindings.json`, including account profiles and `CLAUDE_CONFIG_DIR`.

Mod code lives under Orca's userData directory, in a folder named by its content
hash. Different builds cannot rewrite a running session's mod. Orca appends this
folder to the pane's `CLAUDE_CODE_PLUGIN_DIRS` and adds a session-only
`--plugin-dir` argument to recognized Claude launch commands. Existing plugin
paths and `enabledPlugins` stay intact. Claude 2.1.309's user-settings `env` block
overrides the process plugin-path variable; the CLI argument preserves the
settings-provided plugins while adding Orca's mod. A manually typed Claude or
an opaque custom wrapper needs `--plugin-dir` explicitly when user settings
override the environment.

Orca tries unused Ctrl+Alt+G, H, then V bindings for `command:orca-agent-view`.
JSONC comments and existing shortcuts are preserved. A per-config
`orca-agent-view.json` ownership record remembers setup: deleting or editing
the shortcut does not cause Orca to add it again. To restore navigation after
removing it, manually bind one of those chords to `command:orca-agent-view`.
Turning the setting off removes the recorded owned shortcut from the default
config and account profiles and stops mod loading in new panes. The ownership
record distinguishes this removal from a shortcut you deleted yourself:
re-enabling restores shortcuts removed by Orca; your deletions stay deleted.
Reused user bindings remain untouched. Removing status hooks has the same
owned-shortcut cleanup behavior.

Setup runs asynchronously at startup, when navigation settings change, and
when a new account profile is provisioned. Reconciliation is serialized and
PTY spawns use the cached plugin folder without reading or writing HOME.
Only opted-in local Claude launches wait for pending setup, for at most 200 ms.
Plain shells, other agents, WSL panes and disabled navigation never wait for it.
If setup exceeds that budget, subsequent panes can use navigation once setup
finishes. Disabled cleanup visits known config directories and any config directory
already cached from the login environment, without starting or waiting for a shell
probe.
The login-environment cache lasts only for the current process. If Orca starts with
navigation off before a config directory from shell startup files is cached,
cleanup can miss its old shortcut. Filling that cache later does not trigger
another cleanup.
With navigation off, Orca leaves `CLAUDE_CODE_PLUGIN_DIRS` untouched unless it
must strip a previously inherited Orca plugin path.

The previous owned `skills/orca-agent-view` installation is retired from the
default config and account profiles during asynchronous refresh. SSH/WSL hook
setup retires the owned remote installation too, moving it out of `skills`.
Unowned folders remain untouched. Malformed keybindings are preserved, the
global mod is retired, and its binding cleanup is retried after the JSONC is
repaired. WSL loads a versioned guest-resident mod from relay storage; it never
receives a Windows plugin path. Updated paired runtime hosts use their own
storage and opt-in setting. Older hosts safely decline navigation.

## Delivery

The mod registers its pane, Claude session and module instance with Orca's
existing authenticated loopback hook listener. A click creates one
request only when a live observation reports a different viewed agent. It sends
the configured command shortcut through the guarded terminal input path. The command consumes the request, calls `$.ui.view({ agentId })`
or `$.ui.view({})`, and acknowledges the result. No slash command or Enter is
sent to the composer.

Requests expire after 1.5 seconds and acknowledgements time out after 5.5
seconds. Orca rechecks the exact terminal binding, Claude session, module
registration, permission state and mobile input ownership before writing.
Registration follows session changes after `/clear` or `/resume`, and rereads
the endpoint file so a surviving Claude process can reconnect after Orca
restarts. Updated remote runtime hosts serve the same RPC; the WSL hook relay
forwards mod requests and replies. An older host without the method or a pane
without a live mod registration receives no shortcut.

A newer click supersedes a pending selection. Parent clicks while already on
main and clicks on the currently viewed child send no input. Without a current
observation, navigation fails closed. The mod reports Claude's `AbovePrompt` view
through the authenticated bridge. One host stream carries these observations
to desktop rows; ended, expired or disconnected sessions lose their marker
until fresh evidence arrives. Hosts without observation support receive no shortcut.

## Limits and validation

Claude's mod API is early access; version alone does not guarantee availability.
The indicator tooltip warns that **Esc stops the viewed subagent**; use the
parent row to return. Enter sends the preserved draft to the viewed subagent.

Rollout, safe mode or customization policy can prevent loading. Completed
agents can disappear from Claude's retained task roster and become unavailable.
Mobile child rows retain their existing parent-pane navigation.

Live validation used Claude Code 2.1.309 on Linux: selecting a real child and
returning to its parent preserved a plain-text draft, including after `/clear`
and an endpoint port/token replacement. Hidden Electron/Playwright validation
clicks both compact and full sidebar layouts and verifies actual RPC/PTY
delivery and keyboard-driven observation updates with an owned protocol fixture.
Live Claude also reported returning to main through its keyboard navigation.
Unit tests cover installation,
shortcut collisions, JSONC preservation, request expiry, stale identities,
permission/PTY/input-ownership races, and WSL forwarding. Native macOS, Windows,
live remote hosts, attachment drafts and every Claude modal variant have not
been exercised.

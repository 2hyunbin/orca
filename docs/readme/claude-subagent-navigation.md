# Claude subagent navigation

Click a Claude child row in the desktop sidebar or dashboard to open that
subagent's transcript in Claude's terminal view. Click the parent row to return
to the main conversation. The composer draft stays in place.

An eye marks the transcript Claude is displaying. It follows Claude's keyboard
navigation too. When child rows are collapsed, the parent shows the viewed
child's name; the compact group summary keeps the focused agent's indicator.

## Setup

Enable Orca's agent status hooks and use Claude Code 2.1.300 or newer. Orca's
managed hook installer writes an owned mod to
`<Claude config>/skills/orca-agent-view/`. Restart Claude after the first install.
The selected config includes custom `CLAUDE_CONFIG_DIR` profiles.

The installer preserves installed plugins, other skills, `enabledPlugins`, and
`CLAUDE_CODE_PLUGIN_DIRS`. It adds an unused `command:orca-agent-view` binding to
`keybindings.json`, trying Ctrl+Alt+G, H, then V. Existing bindings and JSONC
comments are preserved. An unowned folder with the same name, malformed
bindings, or all three occupied shortcuts causes installation to be skipped.
Removing Orca's hooks removes its owned mod and command bindings.

## Delivery

The mod registers its pane, Claude session and module instance with Orca's
existing authenticated loopback hook listener. A sidebar click creates one
request and sends the configured command shortcut through the guarded terminal
input path. The command consumes the request, calls `$.ui.view({ agentId })`
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

A newer click supersedes a pending selection, so returning to the parent does
not get lost while a child opens. The mod reports Claude's `AbovePrompt` view
through the authenticated bridge. One host stream carries these observations
to desktop rows; ended, expired or disconnected sessions lose their marker
until fresh evidence arrives. Older hosts without observation support retain
navigation without a view indicator.

## Limits and validation

Claude's mod API is early access; version alone does not guarantee availability.
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

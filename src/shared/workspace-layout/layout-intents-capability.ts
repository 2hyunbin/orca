// A layout-owner server's promise to a paired desktop (design H5). Advertised in status.get only
// by a build with ORCA_LAYOUT_OWNER=main, it versions this contract as one unit:
// - `layout.subscribe` frames: a snapshot, then one records frame per operation carrying the
//   stream's `epoch` and gapless `seq` (workspace-layout-stream-frames.ts); a reader that sees a
//   gap or a new epoch resubscribes for a fresh snapshot.
// - `layout.apply` takes the window's commands for this server's workspaces, and only additive
//   fields join its params; the reply names the `seq` holding its effect.
// A desktop without it on the server keeps the session.tabs mirror, which the server still serves.
// View facts (the group a client shows) are a client's, never shared layout: the server keeps them
// per connection and opens a CLI or phone file in the most recently active client's group, else
// the saved view's.
export const LAYOUT_INTENTS_RUNTIME_CAPABILITY = 'layout.intents.v1' as const

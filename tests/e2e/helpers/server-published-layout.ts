// A paired server's own published layout of one workspace, read over a stream of the test's own.
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection'
import { decodePairingOffer } from '../../../src/shared/pairing'
import { subscribeRemoteRuntimeRequest } from '../../../src/shared/remote-runtime-client'
import type { PublishedWorkspaceLayout } from '../../../src/shared/workspace-layout/workspace-layout-published'
import { readWorkspaceLayoutStreamFrame } from '../../../src/shared/workspace-layout/workspace-layout-stream-frames'
import type { HeadlessPairedRuntimeHost } from './headless-paired-runtime-host'

/** The first snapshot of `layout.subscribe`; null when none arrives within 10 s. */
export async function readServerLayout(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<PublishedWorkspaceLayout | null> {
  let resolveSnapshot: (value: unknown) => void = () => {}
  const snapshot = new Promise<unknown>((resolve) => {
    resolveSnapshot = resolve
  })
  const subscription = await subscribeRemoteRuntimeRequest<unknown>(
    pairedRuntimeConnectionFromOffer(decodePairingOffer(host.offer.pairingUrl)),
    'layout.subscribe',
    { workspaces: [worktreeId] },
    30_000,
    {
      onResponse: (response) => resolveSnapshot(response.ok ? response.result : null),
      onError: () => resolveSnapshot(null),
      onClose: () => resolveSnapshot(null)
    }
  )
  try {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000))
    const frame = readWorkspaceLayoutStreamFrame(await Promise.race([snapshot, timeout]))
    if (frame?.type !== 'snapshot') {
      return null
    }
    return frame.workspaces.find((entry) => entry.key === worktreeId)?.layout ?? null
  } finally {
    subscription.close()
  }
}

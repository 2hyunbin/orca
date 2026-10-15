import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import {
  closeProviderProcess,
  rootOnlyProviderClosePolicy,
  type ProviderProcessCloseResult
} from './provider-process-close'
import type { ProviderCloseRequest, ProviderProcessGroup } from './provider-process-group'
import { terminateProviderProcessTree } from './provider-process-teardown'

type SupervisedChild = Pick<
  ChildProcessHandle,
  'pid' | 'kill' | 'stdin' | 'exitCode' | 'signalCode' | 'once'
>

/**
 * Closes a group-led child that is not a managed provider process: the shared close, with the
 * root-only policy, its tree forced (filed under `site`) only after the group's own stop.
 */
export async function stopSupervisedChildProcess(
  child: SupervisedChild,
  group: ProviderProcessGroup,
  {
    site,
    closeRequest = 'stdin-end-and-sigterm'
  }: { site: string; closeRequest?: ProviderCloseRequest }
): Promise<ProviderProcessCloseResult> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  if (exited()) {
    return { root: 'exited', tree: await group.exited ? 'exited' : 'unverifiable' }
  }
  return closeProviderProcess({
    child,
    exitPromise: new Promise<void>((resolve) => child.once('exit', () => resolve())),
    rootVerdict: () => (exited() ? 'exited' : 'live'),
    group,
    policy: { ...rootOnlyProviderClosePolicy, closeRequest },
    terminateTree: () => terminateProviderProcessTree(child, { site })
  })
}

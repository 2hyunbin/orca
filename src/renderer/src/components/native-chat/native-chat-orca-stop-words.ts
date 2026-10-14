// The words for a reply cut off with nobody asking, by cause and machine. One module, so the chat's
// row wording can change in one place.

import { translate } from '@/i18n/i18n'
import type { AgentSessionOrcaStopCause } from '../../../../shared/agent-session-orca-stop'
import { joinSentences } from '../../../../shared/sentence-joining'

const STOPPED: Record<AgentSessionOrcaStopCause, (machine: string) => string> = {
  update: (machine) =>
    translate(
      'components.native-chat.notices.orcaStopUpdate',
      'Orca on {{machine}} restarted for an update while this response was in progress.',
      { machine }
    ),
  quit: (machine) =>
    translate(
      'components.native-chat.notices.orcaStopQuit',
      'Orca on {{machine}} was closed while this response was in progress.',
      { machine }
    ),
  crash: (machine) =>
    translate(
      'components.native-chat.notices.orcaStopCrash',
      'Orca on {{machine}} stopped unexpectedly while this response was in progress.',
      { machine }
    )
}

// A remote graceful stop is a server stop or a shared desktop's quit; "stopped" is true of both.
const remoteQuit = (machine: string): string =>
  translate(
    'components.native-chat.notices.orcaStopRemote',
    'Orca on {{machine}} stopped while this response was in progress.',
    { machine }
  )

function stoppedSentence(
  cause: AgentSessionOrcaStopCause,
  machine: string,
  remoteHost: boolean
): string {
  return cause === 'quit' && remoteHost ? remoteQuit(machine) : STOPPED[cause](machine)
}

/** Where the host can continue a cut, Continue is the way on, so the row does not say it again;
 *  decided by the host, not the button, so the words never change on screen. */
function withContinueHint(stopped: string, continueAvailable: boolean): string {
  return continueAvailable
    ? stopped
    : joinSentences([
        stopped,
        translate(
          'components.native-chat.notices.orcaStopCanContinue',
          'You can continue in this conversation.'
        )
      ])
}

/** The row's sentence, naming why Orca stopped and on which machine. */
export function nativeChatOrcaStopRowText(
  cause: AgentSessionOrcaStopCause,
  machine: string,
  options: { continueAvailable: boolean; remoteHost: boolean }
): string {
  return withContinueHint(
    stoppedSentence(cause, machine, options.remoteHost),
    options.continueAvailable
  )
}

/** The row's sentence when no cause is known. */
export function nativeChatInterruptedRowText(continueAvailable: boolean): string {
  return withContinueHint(
    translate(
      'components.native-chat.notices.orcaStopInterrupted',
      'This response was interrupted.'
    ),
    continueAvailable
  )
}

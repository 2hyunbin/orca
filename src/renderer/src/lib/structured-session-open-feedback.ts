import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** The feedback a click that opens a chat gives when it cannot, shared by every surface that
 *  opens one. */
export const structuredSessionOpenFeedback = {
  unavailable: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.unavailable',
        'This chat could not reopen yet. Retry in a moment.'
      )
    )
  },
  // Why a second message: once reveal exists, a miss is no longer a timing problem the user can
  // wait out, so telling them to retry sends them in a circle.
  gone: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.gone',
        'This chat is no longer on this host, so it cannot be reopened here.'
      )
    )
  },
  // Separate from `gone` because the chat is not gone: something about this pairing cannot open
  // it — a host too old to know the method, adapters that do not cover the provider, or a version
  // block that can name EITHER side. Naming a machine here would point half of those at the wrong
  // one, so the message names the remedy instead. Telling someone their work is lost when an
  // update would bring it back is the worse of the two wrong answers.
  hostCannotOpen: () => {
    toast.error(
      translate(
        'auto.lib.activateAiVaultStructuredSession.hostCannotOpen',
        "This chat can't be reopened until Orca is updated."
      )
    )
  }
}

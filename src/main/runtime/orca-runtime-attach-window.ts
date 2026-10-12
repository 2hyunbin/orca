import type { RuntimeSessionGraphPromotion } from './session-graph/session-graph-promotion'
import { OrcaRuntimeWithNotifySshStateChanged } from './orca-runtime-notify-ssh-state-changed'

export abstract class OrcaRuntimeWithAttachWindow extends OrcaRuntimeWithNotifySshStateChanged {
  attachWindow(
    ...args: Parameters<RuntimeSessionGraphPromotion['attachWindow']>
  ): ReturnType<RuntimeSessionGraphPromotion['attachWindow']> {
    return this.runtimeSessionGraphPromotion.attachWindow(...args)
  }

  protected persistWindowlessPtyBindingsForDesktopAttach(
    ...args: Parameters<
      RuntimeSessionGraphPromotion['persistWindowlessPtyBindingsForDesktopAttach']
    >
  ): ReturnType<RuntimeSessionGraphPromotion['persistWindowlessPtyBindingsForDesktopAttach']> {
    return this.runtimeSessionGraphPromotion.persistWindowlessPtyBindingsForDesktopAttach(...args)
  }
}

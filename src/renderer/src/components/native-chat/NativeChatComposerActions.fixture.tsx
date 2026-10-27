import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatComposerActions } from './NativeChatComposerActions'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

function WorkingFollowUp({ blocked = false }: { blocked?: boolean }) {
  const [draft, setDraft] = useState('Also check the queue cancellation tests.')
  const [working, setWorking] = useState(true)
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({})}
    >
      <div className="rounded-2xl border border-border bg-background p-2">
        <p className="min-h-12 px-2 py-1 text-sm text-chat-foreground-strong">{draft}</p>
        <NativeChatComposerActions
          attachDisabled={false}
          dictationDisabled
          sendDisabled={blocked || draft === ''}
          sendBlockedReason={blocked ? 'Remove the unavailable image to send.' : null}
          hasDraft={draft !== ''}
          isWorking={working}
          isDictating={false}
          isDictationHoldMode={false}
          onAttach={() => {}}
          onDictationToggle={() => {}}
          onDictationHoldStart={() => {}}
          onDictationHoldEnd={() => {}}
          onSend={() => setDraft('')}
          onStop={() => setWorking(false)}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
        />
      </div>
    </div>
  )
}

export const workingDraft = defineFixture({ width: 560, render: () => <WorkingFollowUp /> })

export const focusedStop = defineFixture({
  width: 560,
  render: () => <WorkingFollowUp />,
  interact: (frame) =>
    frame
      .querySelector<HTMLButtonElement>('button[data-native-chat-critical-action="stop"]')
      ?.focus()
})

export const narrowWorkingDraft = defineFixture({ width: 320, render: () => <WorkingFollowUp /> })

export const blockedWorkingDraft = defineFixture({
  width: 560,
  render: () => <WorkingFollowUp blocked />
})

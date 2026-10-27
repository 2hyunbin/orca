import { useState } from 'react'
import { toast } from 'sonner'
import { NotificationCardStack } from '@/components/NotificationCardStack'
import { StarNagCard } from '@/components/StarNagCard'
import { StarNagToastHost } from '@/components/star-nag/StarNagToastHost'
import { NativeChatComposerActions } from '@/components/native-chat/NativeChatComposerActions'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

type Show = Parameters<Window['api']['starNag']['onShow']>[0]
const showListeners = new Set<Show>()
const hideListeners = new Set<() => void>()
const notify = (surface: 'card' | 'toast') => {
  for (const listener of showListeners) {
    listener({ surface, mode: 'web' })
  }
}
const hide = () => {
  for (const listener of hideListeners) {
    listener()
  }
}
Object.defineProperty(window, 'api', {
  configurable: true,
  value: {
    starNag: {
      onShow: (callback: Show) => {
        showListeners.add(callback)
        return () => showListeners.delete(callback)
      },
      onHide: (callback: () => void) => {
        hideListeners.add(callback)
        return () => hideListeners.delete(callback)
      },
      dismiss: async () => {},
      later: async () => {},
      openWeb: async () => {}
    },
    shell: { openUrl: async () => {} }
  }
})

export function NotificationFixture(): React.JSX.Element {
  const [working, setWorking] = useState(false)
  const [sends, setSends] = useState(0)
  const [stops, setStops] = useState(0)
  const [actions, setActions] = useState(0)
  return (
    <TooltipProvider>
      <div className="titlebar">Workspace</div>
      <nav className="fixed left-0 top-1/2 flex flex-col items-start gap-2">
        <button
          onClick={() =>
            toast.warning('Notifications are blocked', {
              id: 'warning',
              duration: Infinity,
              action: {
                label: 'System Settings',
                onClick: (event) => {
                  event.preventDefault()
                  setActions((n) => n + 1)
                }
              }
            })
          }
        >
          Show warning
        </button>
        <button
          onClick={() =>
            toast.success('Notifications enabled', { id: 'warning', duration: Infinity })
          }
        >
          Update warning
        </button>
        <button onClick={() => notify('toast')}>Show star toast</button>
        <button onClick={() => notify('card')}>Show star card</button>
        <button
          onClick={() => {
            toast.dismiss()
            hide()
          }}
        >
          Reset notifications
        </button>
      </nav>
      <output>
        Sends: {sends}; Stops: {stops}; Notification actions: {actions}
      </output>
      <section className="native-chat-appearance fixed bottom-6 right-4 w-[60%] rounded-xl border bg-background p-3">
        <textarea aria-label="Composer" className="h-20 w-full" defaultValue="Test prompt" />
        <NativeChatComposerActions
          attachDisabled
          dictationDisabled
          sendDisabled={false}
          isWorking={working}
          isDictating={false}
          isDictationHoldMode={false}
          sessionOptionsSurface={null}
          sessionOptionsSnapshot={[]}
          onAttach={() => {}}
          onDictationToggle={() => {}}
          onDictationHoldStart={() => {}}
          onDictationHoldEnd={() => {}}
          onSend={() => {
            setSends((n) => n + 1)
            setWorking(true)
          }}
          onStop={() => {
            setStops((n) => n + 1)
            setWorking(false)
          }}
        />
      </section>
      <Toaster closeButton />
      <NotificationCardStack>
        <StarNagCard />
      </NotificationCardStack>
      <StarNagToastHost />
    </TooltipProvider>
  )
}

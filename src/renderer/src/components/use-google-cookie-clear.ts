import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getBrowserSettingsHostId } from '@/store/slices/browser/browser-host-state'
import { useConfirmationDialog } from './confirmation-dialog-context'
import {
  offerGoogleCookieClear,
  type GoogleCookieClearOffer
} from '@/lib/browser-google-cookie-clear'

export function useGoogleCookieClear(profileId: string, label?: string) {
  const confirm = useConfirmationDialog()
  const hostId = useAppStore(getBrowserSettingsHostId)
  const statuses = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const running = useRef(false)
  const generation = useRef(0)
  const [pending, setPending] = useState(true)
  const [busy, setBusy] = useState(false)
  const [menuOffer, setMenuOffer] = useState<GoogleCookieClearOffer>()
  const offer = useCallback(
    () =>
      offerGoogleCookieClear(profileId, label, confirm, (action) => {
        if (running.current) {
          return
        }
        running.current = true
        setBusy(true)
        void action().finally(() => {
          running.current = false
          setBusy(false)
        })
      }),
    [profileId, label, confirm]
  )
  const refresh = useCallback(() => {
    const current = ++generation.current
    void offer().then((next) => {
      if (generation.current === current) {
        setMenuOffer(next)
        setPending(false)
      }
    })
  }, [offer])
  useEffect(() => {
    setPending(true)
    setMenuOffer(undefined)
    refresh()
    return () => {
      generation.current++
    }
  }, [refresh, hostId, statuses])
  return {
    busy,
    menuAction: menuOffer?.onClick,
    offer,
    refresh,
    pending
  }
}

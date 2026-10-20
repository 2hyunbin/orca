import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchProviderAccountsSnapshot,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** The switchers share snapshot loading; a failed provider half never replaces its roster. */
export function useProviderAccountList<Provider extends 'claude' | 'codex'>(
  provider: Provider,
  target: RuntimeClientTarget,
  syncKey: string,
  initial: ProviderAccountsSnapshot[Provider]
) {
  const [accounts, setAccounts] = useState(initial)
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const loadAccounts = useCallback(async () => {
    const snapshot = await fetchProviderAccountsSnapshot(target)
    if (snapshot.failedProviders?.includes(provider)) {
      console.error(`${provider} account list failed; keeping previous state.`)
      return
    }
    if (mountedRef.current) {
      setAccounts(snapshot[provider])
      setAccountsLoaded(true)
    }
  }, [provider, target])
  useEffect(() => {
    void loadAccounts().catch((error: unknown) => {
      console.error(`Failed to load ${provider} accounts:`, error)
    })
  }, [loadAccounts, provider, syncKey])
  return { accounts, setAccounts, accountsLoaded, loadAccounts, mountedRef }
}

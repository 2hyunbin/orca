import { useEffect, useState } from 'react'
import type { JiraProject } from '../../../shared/jira-types'
import {
  jiraListProjects,
  jiraStatus,
  type RuntimeJiraSettings
} from '@/runtime/runtime-jira-client'

export function useJiraProjectInventory(source: RuntimeJiraSettings, enabled: boolean) {
  const [inventory, setInventory] = useState<{
    source: RuntimeJiraSettings
    projects: JiraProject[]
    connected: boolean
    error: string | null
  } | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void jiraStatus(source)
      .then(async (status) => ({
        source,
        connected: status.connected,
        projects: status.connected ? await jiraListProjects(source, 'all') : [],
        error: null
      }))
      .then((next) => {
        if (!cancelled) {
          setInventory(next)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setInventory({
            source,
            connected: false,
            projects: [],
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [source, enabled])
  const current = inventory?.source === source ? inventory : null
  return {
    projects: current?.projects ?? [],
    connected: current?.connected ?? false,
    error: current?.error ?? null,
    loading: enabled && current === null
  }
}

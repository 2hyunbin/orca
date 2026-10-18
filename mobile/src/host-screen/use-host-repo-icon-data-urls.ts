import { useEffect, useRef, useState } from 'react'
import { MAX_REPO_ICON_IDS_PER_READ } from '../../../src/shared/sidebar-list/repo-icon-data-urls-contract'
import type { RpcClient } from '../transport/rpc-client'
import { readHostMethodReply, sidebarRepoIconsRead } from './host-sidebar-feed-operations'

/**
 * The data URL behind each icon id the feed names, read once per id and client. Null: the host has
 * no image within its caps, and the phone draws its own badge. Ids are content hashes, so a changed
 * icon arrives as a new id.
 */
export function useHostRepoIconDataUrls(
  client: RpcClient | null,
  ids: readonly string[]
): ReadonlyMap<string, string | null> {
  const [dataUrls, setDataUrls] = useState<ReadonlyMap<string, string | null>>(new Map())
  const askedRef = useRef(new Set<string>())
  const clientRef = useRef(client)

  useEffect(() => {
    clientRef.current = client
    askedRef.current = new Set()
    setDataUrls(new Map())
  }, [client])

  useEffect(() => {
    if (!client) {
      return
    }
    const wanted = ids.filter((id) => !askedRef.current.has(id))
    for (let start = 0; start < wanted.length; start += MAX_REPO_ICON_IDS_PER_READ) {
      const batch = wanted.slice(start, start + MAX_REPO_ICON_IDS_PER_READ)
      batch.forEach((id) => askedRef.current.add(id))
      void sidebarRepoIconsRead
        .request(client, { ids: batch })
        .then((reply) => readHostMethodReply(reply, sidebarRepoIconsRead.interpret))
        .catch(() => ({ kind: 'failed' as const }))
        .then((read) => {
          if (clientRef.current !== client) {
            return
          }
          if (read.kind === 'failed') {
            // Asked again on the next feed install; a host without the method is not.
            batch.forEach((id) => askedRef.current.delete(id))
          }
          if (read.kind !== 'answered') {
            return
          }
          setDataUrls((current) => {
            const next = new Map(current)
            read.value.icons.forEach(({ id, dataUrl }) => next.set(id, dataUrl))
            return next
          })
        })
    }
  }, [client, ids])

  return dataUrls
}

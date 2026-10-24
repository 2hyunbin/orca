import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { JournalStructuralScratch } from './journal-structural-scratch'
import { WorkBucket, type Work } from './journal-work-bucket'

it('preserves the scan selector through ties, keyed staging and atomic scratch reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-work-index-'))
  const path = join(root, 'scratch.db')
  let scratch = new JournalStructuralScratch(path)
  let bucket = new WorkBucket(scratch, 'cut:raw\0\ud800')
  const entries = new Map<string, Work>()
  let head: Work | undefined
  const work = (key: string, sequence: number, sequenceIndex = 0): Work => ({
    fact: { itemId: `item:${key}`, since: 100 + sequence },
    item: {
      itemId: `item:${key}`,
      revision: 1,
      sequence,
      sequenceIndex,
      observedAt: 9999,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      body: { kind: 'turn', turnId: key, state: 'running' }
    }
  })
  const changes: [string, Work | undefined][] = [
    ['A', work('A', 2)],
    ['B', work('B', 1)],
    ['A', work('A', 1)], // B stays sticky despite A's earlier insertion.
    ['B', work('B', 1, 1)], // Moving the head recomputes A.
    ['C', work('C', 1)],
    ['A', { ...work('A', 1), fact: { itemId: 'item:A', since: 777 } }],
    ['A', undefined],
    ['A', work('A', 1)], // Reinsert comes after C in a recomputed tie.
    ['B', undefined],
    ['C', work('C', 3)],
    ['late\0\ud800', work('late\0\ud800', 0)],
    ['A', undefined],
    ['late\0\ud800', undefined],
    ['C', undefined]
  ]
  try {
    for (const [key, value] of changes) {
      const previous = entries.get(key)
      if (value) {
        entries.set(key, value)
      } else {
        entries.delete(key)
      }
      if (previous && previous.item.itemId === head?.item.itemId) {
        head = value
        if (!value || compareAgentJournalItems(previous.item, value.item) !== 0) {
          head = undefined
          for (const candidate of entries.values()) {
            if (!head || compareAgentJournalItems(candidate.item, head.item) < 0) {
              head = candidate
            }
          }
        }
      } else if (value && (!head || compareAgentJournalItems(value.item, head.item) < 0)) {
        head = value
      }
      const before = bucket.checkpoint()
      const staged = bucket.fork()
      staged.update(key, value)
      expect(staged.head).toEqual(head)
      expect(bucket.checkpoint()).toEqual(before)
      scratch.db.exec('BEGIN IMMEDIATE')
      const failed = new WorkBucket(scratch, bucket.key, before)
      failed.update(key, value)
      scratch.save(failed.checkpoint())
      scratch.db.exec('ROLLBACK')
      bucket = new WorkBucket(scratch, bucket.key, before)
      expect(bucket.checkpoint()).toEqual(before)
      scratch.db.exec('BEGIN IMMEDIATE')
      bucket.update(key, value)
      scratch.save(bucket.checkpoint())
      scratch.db.exec('COMMIT')
      scratch.close()
      scratch = new JournalStructuralScratch(path)
      bucket = new WorkBucket(scratch, bucket.key, scratch.load())
      expect(bucket.head).toEqual(head)
      expect([...bucket.entries]).toEqual([...entries])
    }
    expect(bucket.checkpoint()).toMatchObject({ count: 0, head: undefined })
    expect(scratch.map('work:cut:raw\0\ud800:slots').size).toBe(0)
    expect(scratch.map('work:cut:raw\0\ud800:positions').size).toBe(0)
  } finally {
    scratch.close()
    await rm(root, { recursive: true, force: true })
  }
})

import { useState } from 'react'
import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import TabBar from './TabBar'

const WORKSPACE_ID = 'tab-width-fixture'
const TITLES = [
  'Should we regenerate the conversation title?',
  'Native chat tab title regeneration',
  'Codex Chat',
  "You're the president agent coordinating this review"
]
const noop = (): void => {}

function TabWidthFixture({
  count,
  titles = TITLES
}: {
  count: number
  titles?: string[]
}): React.JSX.Element {
  const [activeTabId, setActiveTabId] = useState('tab-0')
  const tabs: TerminalTab[] = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    worktreeId: WORKSPACE_ID,
    ptyId: null,
    title: titles[index % titles.length],
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 0,
    launchAgent: 'codex'
  }))

  return (
    <DndContext>
      <div className="@container/tab-strip h-8 bg-card">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          activeTabType="terminal"
          worktreeId={WORKSPACE_ID}
          groupId="tab-width-group"
          expandedPaneByTabId={{}}
          showAgentLaunchItems={false}
          onActivate={setActiveTabId}
          onClose={noop}
          onCloseOthers={noop}
          onCloseToRight={noop}
          onCloseToLeft={noop}
          onNewTerminalTab={noop}
          onNewBrowserTab={noop}
          onSetCustomTitle={noop}
          onSetTabColor={noop}
          onTogglePaneExpand={noop}
        />
      </div>
    </DndContext>
  )
}

export const spacious = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={4} />
})

export const single = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['Terminal 1']} />
})

export const long = defineFixture({
  width: 1280,
  render: () => <TabWidthFixture count={1} titles={['A very long conversation title '.repeat(8)]} />
})

export const narrow = defineFixture({
  width: 420,
  render: () => <TabWidthFixture count={4} />
})

export const overflowing = defineFixture({
  width: 420,
  render: () => <TabWidthFixture count={12} />
})

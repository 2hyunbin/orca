import { useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { QueuedMessageCard } from './structured-agent-session-queued-cards'
import type { QueuedMessageReorder } from './use-structured-agent-session-queued-reorder'

export type QueuedMessageDragPresentation = {
  rowRef: Ref<HTMLLIElement>
  rowStyle: CSSProperties
  grip: ReactNode
  insertion: 'before' | 'after' | undefined
}

type Props = {
  cards: QueuedMessageCard[]
  reorder?: QueuedMessageReorder
  renderCard: (card: QueuedMessageCard, drag?: QueuedMessageDragPresentation) => ReactNode
}

export function NativeChatQueuedMessageRows(props: Props): ReactNode {
  if (!props.reorder) {
    return props.cards.map((card) => props.renderCard(card))
  }
  // A changed membership or host cancels a drag; order publications keep stable row identities.
  const membership = props.cards
    .map((card) => card.messageId)
    .sort()
    .join('\u0000')
  return (
    <SortableQueuedMessages
      key={`${props.reorder.scope}:${membership}`}
      {...props}
      reorder={props.reorder}
    />
  )
}

function SortableQueuedMessages({
  cards,
  reorder,
  renderCard
}: Props & { reorder: QueuedMessageReorder }): React.JSX.Element {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const users = cards.filter((card) => !card.from && card.hold !== 'sending')
  const [drag, setDrag] = useState<{ from: string; over: string } | null>(null)
  const fromIndex = users.findIndex((card) => card.messageId === drag?.from)
  const overIndex = users.findIndex((card) => card.messageId === drag?.over)
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={({ active }) => setDrag({ from: String(active.id), over: String(active.id) })}
      onDragOver={({ active, over }) =>
        setDrag(over ? { from: String(active.id), over: String(over.id) } : null)
      }
      onDragCancel={() => setDrag(null)}
      onDragEnd={({ active, over }) => {
        setDrag(null)
        if (!over || active.id === over.id) {
          return
        }
        const from = users.findIndex((card) => card.messageId === active.id)
        const to = users.findIndex((card) => card.messageId === over.id)
        if (from !== -1 && to !== -1) {
          void reorder.move(
            String(active.id),
            from < to ? { afterMessageId: String(over.id) } : { beforeMessageId: String(over.id) }
          )
        }
      }}
    >
      <SortableContext
        items={users.map((card) => card.messageId)}
        strategy={verticalListSortingStrategy}
      >
        {cards.map((card) => (
          <SortableQueuedMessage
            key={card.messageId}
            card={card}
            users={users}
            reorder={reorder}
            insertion={
              card.messageId === drag?.over && fromIndex !== overIndex
                ? fromIndex < overIndex
                  ? 'after'
                  : 'before'
                : undefined
            }
            renderCard={renderCard}
          />
        ))}
      </SortableContext>
    </DndContext>
  )
}

function SortableQueuedMessage({
  card,
  users,
  reorder,
  insertion,
  renderCard
}: {
  card: QueuedMessageCard
  users: QueuedMessageCard[]
  reorder: QueuedMessageReorder
  insertion: QueuedMessageDragPresentation['insertion']
  renderCard: Props['renderCard']
}): ReactNode {
  const movable = !card.from && card.hold !== 'sending'
  const sortable = useSortable({ id: card.messageId, disabled: !movable || reorder.pending })
  const label = translate('components.native-chat.queuedMessages.reorderMessage', 'Reorder message')
  return renderCard(card, {
    rowRef: sortable.setNodeRef,
    rowStyle: {
      transform: CSS.Transform.toString(sortable.transform),
      transition: sortable.transition
    },
    insertion,
    grip: movable ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            ref={sortable.setActivatorNodeRef}
            className="shrink-0 cursor-grab touch-none opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
            {...sortable.attributes}
            {...sortable.listeners}
            aria-label={label}
            aria-keyshortcuts="ArrowUp ArrowDown"
            aria-disabled={reorder.pending}
            onKeyDown={(event) => {
              if (reorder.pending || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
                return
              }
              event.preventDefault()
              const index = users.indexOf(card)
              const neighbor = users[index + (event.key === 'ArrowUp' ? -1 : 1)]
              if (neighbor) {
                void reorder.move(
                  card.messageId,
                  event.key === 'ArrowUp'
                    ? { beforeMessageId: neighbor.messageId }
                    : { afterMessageId: neighbor.messageId }
                )
              }
            }}
          >
            <GripVertical className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate(
            'components.native-chat.queuedMessages.reorderHint',
            'Drag to reorder, or use the Up and Down arrow keys.'
          )}
        </TooltipContent>
      </Tooltip>
    ) : null
  })
}

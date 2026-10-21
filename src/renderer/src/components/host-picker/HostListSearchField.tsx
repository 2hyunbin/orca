import { Input } from '@/components/ui/input'
import { searchHostsLabel } from './host-picker-copy'

/** Search box for a bounded host checklist. */
export function HostListSearchField({
  value,
  onChange,
  inMenu = false
}: {
  value: string
  onChange: (value: string) => void
  /** Inside a dropdown menu: keep typed letters out of the menu's typeahead. */
  inMenu?: boolean
}): React.JSX.Element {
  return (
    <div className="p-1">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={
          inMenu
            ? (event) => {
                if (event.key !== 'Escape' && event.key !== 'Tab') {
                  event.stopPropagation()
                }
              }
            : undefined
        }
        onPointerDown={inMenu ? (event) => event.stopPropagation() : undefined}
        placeholder={searchHostsLabel()}
        aria-label={searchHostsLabel()}
        className="h-7"
      />
    </div>
  )
}

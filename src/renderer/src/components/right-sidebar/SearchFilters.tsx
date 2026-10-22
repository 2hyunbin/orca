import React from 'react'
import { ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'

export type SearchFiltersProps = {
  includePattern: string
  excludePattern: string
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
  includeInputRef?: React.RefObject<HTMLInputElement | null>
  excludeInputRef?: React.RefObject<HTMLInputElement | null>
}

export function SearchFilters({
  includePattern,
  excludePattern,
  onIncludeChange,
  onExcludeChange,
  includeInputRef,
  excludeInputRef
}: SearchFiltersProps): React.JSX.Element {
  const activeCount =
    Number(Boolean(includePattern.trim())) + Number(Boolean(excludePattern.trim()))

  return (
    <Collapsible defaultOpen={activeCount > 0} data-ignore-file-explorer-keys="true">
      <CollapsibleTrigger variant="compact">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        <span>{translate('fileSearch.filters.label', 'Search filters')}</span>
        {activeCount > 0 && (
          <span className="ml-auto rounded-sm bg-accent px-1.5 text-2xs tabular-nums text-accent-foreground">
            {translate('fileSearch.filters.active', '{{count}} active', { count: activeCount })}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent animation="height">
        <div className="space-y-2 pb-2 pt-1">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.SearchFilters.a69ee1bd0e',
                'Files to include'
              )}
            </span>
            <Input
              ref={includeInputRef}
              type="text"
              data-file-search-input="true"
              density="compact"
              placeholder={translate(
                'auto.components.right.sidebar.SearchFilters.8a77efcbd1',
                'e.g. *.ts, src/**'
              )}
              value={includePattern}
              onChange={(e) => onIncludeChange(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.SearchFilters.0a6412a895',
                'Files to exclude'
              )}
            </span>
            <Input
              ref={excludeInputRef}
              type="text"
              data-file-search-input="true"
              density="compact"
              placeholder={translate(
                'auto.components.right.sidebar.SearchFilters.01e4671ccf',
                'e.g. *.min.js, dist/**'
              )}
              value={excludePattern}
              onChange={(e) => onExcludeChange(e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

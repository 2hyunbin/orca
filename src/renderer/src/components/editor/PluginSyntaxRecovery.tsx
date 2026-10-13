import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { usePluginSyntaxFailureStore } from '@/store/plugin-syntax-failures'
import { retryPluginSyntaxModel } from '@/store/plugin-syntax-packs'
import type { PluginGrammarFailureReason } from '@/lib/monaco-languages/plugin-grammar-failure'

function failureMessage(reason: PluginGrammarFailureReason): string {
  switch (reason) {
    case 'load':
      return translate(
        'auto.components.editor.PluginSyntaxRecovery.load',
        'The syntax pack could not be loaded. Retry after restoring or updating it.'
      )
    case 'size':
      return translate(
        'auto.components.editor.PluginSyntaxRecovery.size',
        'This file exceeds the highlighting limit. You can still read it. Choose Plain text in the syntax menu to use the file without highlighting.'
      )
    case 'capacity':
      return translate(
        'auto.components.editor.PluginSyntaxRecovery.capacity',
        'Highlighting is at its work limit. Close unused files, then retry.'
      )
    case 'budget':
      return translate(
        'auto.components.editor.PluginSyntaxRecovery.budget',
        'The syntax worker took too long and was stopped. Retry, or choose Plain text in the syntax menu.'
      )
    case 'worker':
      return translate(
        'auto.components.editor.PluginSyntaxRecovery.worker',
        'The syntax worker could not highlight this file. Retry, or choose Plain text in the syntax menu.'
      )
  }
}

export function PluginSyntaxRecovery({
  modelUris,
  labels
}: {
  modelUris: readonly string[]
  labels?: readonly string[]
}): React.JSX.Element | null {
  const failure = usePluginSyntaxFailureStore((state) =>
    modelUris.map((uri) => state.failures[uri]).find(Boolean)
  )
  if (!failure) {
    return null
  }
  return (
    <div
      role="status"
      aria-label={translate(
        'auto.components.editor.PluginSyntaxRecovery.title',
        'Highlighting paused'
      )}
      className="absolute inset-x-3 bottom-3 z-20 ml-auto max-w-sm rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <AlertCircle className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {translate('auto.components.editor.PluginSyntaxRecovery.title', 'Highlighting paused')}
        {labels?.[modelUris.indexOf(failure.modelUri)] && (
          <span className="text-muted-foreground">
            · {labels[modelUris.indexOf(failure.modelUri)]}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{failureMessage(failure.reason)}</p>
      <Button
        variant="outline"
        size="xs"
        className="mt-3"
        aria-label={translate(
          'auto.components.editor.PluginSyntaxRecovery.retryLabel',
          'Retry highlighting'
        )}
        onClick={() => retryPluginSyntaxModel(failure.modelUri)}
      >
        {translate('auto.components.editor.PluginSyntaxRecovery.retry', 'Retry')}
      </Button>
    </div>
  )
}

import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function DirectoryCopyField({
  label,
  value,
  id
}: {
  label: string
  value: string
  id: string
}): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'copied' | 'manual'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const shortcut = navigator.userAgent.includes('Mac') ? '⌘C' : 'Ctrl+C'
  const copy = async (): Promise<void> => {
    const input = inputRef.current
    const current = (): boolean => Boolean(input?.isConnected && inputRef.current === input)
    try {
      await navigator.clipboard.writeText(value)
      if (!current()) {
        return
      }
      setStatus('copied')
    } catch {
      if (!current()) {
        return
      }
      setStatus('manual')
      input?.focus()
      input?.select()
    }
  }
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex min-w-0 gap-2">
        <Input
          ref={inputRef}
          id={id}
          value={value}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 font-mono md:text-xs"
          spellCheck={false}
          aria-describedby={`${id}-status`}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void copy()}
        >
          {status === 'copied' ? <Check /> : <Copy />}
        </Button>
      </div>
      <p id={`${id}-status`} role="status" className="text-xs text-muted-foreground">
        {status === 'copied'
          ? 'Copied.'
          : status === 'manual'
            ? `Clipboard unavailable. The value is selected; press ${shortcut} to copy.`
            : 'Select the value to copy it manually.'}
      </p>
    </div>
  )
}

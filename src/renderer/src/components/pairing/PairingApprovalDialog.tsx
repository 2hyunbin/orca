import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  normalizeTypedComparisonCode,
  PAIRING_COMPARISON_CODE_LENGTH
} from '../../../../shared/pairing-comparison-code'
import type {
  PairingApprovalAnswer,
  PairingApprovalPrompt
} from '../../../../shared/pairing-approval-prompt'

function authorityDescription(prompt: PairingApprovalPrompt): string {
  const base =
    prompt.scope === 'mobile'
      ? translate(
          'auto.components.pairing.PairingApprovalDialog.authorityMobile',
          'It will be able to use Orca from a phone: open terminals, read files and run agents on this computer as you.'
        )
      : translate(
          'auto.components.pairing.PairingApprovalDialog.authorityRuntime',
          'It will be able to run commands, open terminals, edit files and run agents on this computer as you.'
        )
  return prompt.grants.includes('desktop-control')
    ? `${base} ${translate(
        'auto.components.pairing.PairingApprovalDialog.authorityDesktopControl',
        "It can also control this computer's screen and keyboard."
      )}`
    : base
}

export function PairingApprovalDialog({
  prompt,
  onAnswer
}: {
  prompt: PairingApprovalPrompt
  onAnswer: (answer: PairingApprovalAnswer) => void
}): React.JSX.Element {
  const [typedCode, setTypedCode] = useState('')
  const typing = prompt.mode === 'type-to-confirm'
  const typedComplete =
    normalizeTypedComparisonCode(typedCode).length === PAIRING_COMPARISON_CODE_LENGTH
  const deny = (): void => onAnswer({ requestId: prompt.requestId, decision: 'deny' })
  const allow = (): void =>
    onAnswer({
      requestId: prompt.requestId,
      decision: 'allow',
      ...(typing ? { typedCode } : {})
    })

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : deny())}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.pairing.PairingApprovalDialog.title',
              'Allow a new device to pair with {{hostName}}?',
              { hostName: prompt.hostName }
            )}
          </DialogTitle>
          <DialogDescription>{authorityDescription(prompt)}</DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">
            {translate('auto.components.pairing.PairingApprovalDialog.device', 'Device')}
          </dt>
          <dd className="break-words">{prompt.deviceLabel}</dd>
          <dt className="text-muted-foreground">
            {translate('auto.components.pairing.PairingApprovalDialog.fingerprint', 'Key')}
          </dt>
          <dd className="font-mono text-xs leading-5">{prompt.deviceKeyFingerprint}</dd>
        </dl>

        {prompt.mode === 'compare' ? (
          <div className="space-y-1">
            <p className="text-sm">
              {translate(
                'auto.components.pairing.PairingApprovalDialog.compareInstruction',
                'Allow only if the device shows this same code:'
              )}
            </p>
            <p
              className="font-mono text-2xl font-semibold tracking-widest"
              data-testid="pairing-comparison-code"
            >
              {prompt.comparisonCode}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-destructive">
              {translate(
                'auto.components.pairing.PairingApprovalDialog.replaceWarning',
                'Allowing this replaces {{devices}}, which will be signed out.',
                { devices: prompt.replaces.join(', ') }
              )}
            </p>
            <div className="space-y-1">
              <Label htmlFor="pairing-approval-typed-code">
                {translate(
                  'auto.components.pairing.PairingApprovalDialog.typeCodeLabel',
                  'Type the code shown on the new device'
                )}
              </Label>
              <Input
                id="pairing-approval-typed-code"
                autoComplete="off"
                spellCheck={false}
                value={typedCode}
                maxLength={16}
                onChange={(event) => setTypedCode(event.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={deny}>
            {translate('auto.components.pairing.PairingApprovalDialog.deny', 'Deny')}
          </Button>
          <Button size="sm" onClick={allow} disabled={typing && !typedComplete}>
            {translate('auto.components.pairing.PairingApprovalDialog.allow', 'Allow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

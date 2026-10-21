import { translate } from '@/i18n/i18n'

export function connectedHostCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.SshStatusSegment.connectedHostCount_one',
        '{{count}} host',
        { count }
      )
    : translate(
        'auto.components.status.bar.SshStatusSegment.connectedHostCount_other',
        '{{count}} hosts',
        { count }
      )
}

export function connectingHostsLabel(): string {
  return translate('auto.components.status.bar.SshStatusSegment.connecting', 'Connecting…')
}

export function moreSshHostsLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHosts_one',
        'Search {{count}} more SSH host…',
        { count }
      )
    : translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHosts_other',
        'Search {{count}} more SSH hosts…',
        { count }
      )
}

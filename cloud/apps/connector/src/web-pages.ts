import type { LinkedHost } from './host-links.js'
import type { PendingSignIn } from './sign-in-requests.js'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}
table{border-collapse:collapse}td{padding:.2rem .8rem .2rem 0;vertical-align:top}
.warn{border-left:3px solid #b45309;padding-left:.8rem}button,input{font:inherit;padding:.3rem .7rem}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
}

const csrfField = (csrf: string): string =>
  `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`

export function codeEntryPage(input: { email: string; csrf: string; error?: string }): string {
  return layout(
    'Connect an Orca',
    `<p>Signed in as ${escapeHtml(input.email)}.</p>
<p>Enter the code that <code>orca cloud login</code> printed on your machine.</p>
${input.error ? `<p class="warn">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/host-login">${csrfField(input.csrf)}
<input name="userCode" autocomplete="off" autocapitalize="characters" placeholder="ABCD-EFGH" required>
<button type="submit">Continue</button></form>`
  )
}

export function confirmPage(input: {
  csrf: string
  userCode: string
  pending: PendingSignIn
  now: number
}): string {
  const { pending } = input
  const from = pending.requestLocation
    ? `${pending.requestIp} (${pending.requestLocation})`
    : pending.requestIp
  const decision = (allow: boolean, label: string): string =>
    `<form method="post" action="/host-login/decision" style="display:inline">${csrfField(input.csrf)}
<input type="hidden" name="userCode" value="${escapeHtml(input.userCode)}">
<input type="hidden" name="decision" value="${allow ? 'allow' : 'deny'}">
<button type="submit">${label}</button></form>`
  return layout(
    'Connect this Orca?',
    `<table>
<tr><td>Machine</td><td>${escapeHtml(pending.hostName)}</td></tr>
<tr><td>Platform</td><td>${escapeHtml(pending.platform)} (${escapeHtml(pending.runtime)})</td></tr>
<tr><td>Orca version</td><td>${escapeHtml(pending.orcaVersion)}</td></tr>
<tr><td>Requested from</td><td>${escapeHtml(from)}</td></tr>
<tr><td>Requested</td><td>${ago(input.now - pending.createdAt)}</td></tr>
</table>
<p class="warn">Only allow this if you just ran <code>orca cloud login</code> on that machine yourself.</p>
${decision(true, 'Allow')} ${decision(false, 'Deny')}`
  )
}

export function messagePage(title: string, message: string, link?: { href: string; label: string }): string {
  return layout(
    title,
    `<p>${escapeHtml(message)}</p>${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : ''}`
  )
}

export function machinesPage(input: { email: string; csrf: string; hosts: LinkedHost[] }): string {
  const rows = input.hosts
    .map(
      (host) => `<tr><td>${escapeHtml(host.hostName)}</td>
<td>${escapeHtml(host.platform)} (${escapeHtml(host.runtime)}), Orca ${escapeHtml(host.orcaVersion)}</td>
<td>since ${new Date(host.linkedAt).toISOString().slice(0, 10)}</td>
<td><form method="post" action="/v1/account/hosts/${encodeURIComponent(host.hostId)}/revoke">${csrfField(input.csrf)}
<button type="submit">Revoke</button></form></td></tr>`
    )
    .join('\n')
  return layout(
    'Your connected machines',
    `<p>Signed in as ${escapeHtml(input.email)}.</p>
${input.hosts.length === 0 ? '<p>No machines are connected.</p>' : `<table>${rows}</table>`}`
  )
}

import type { Context, Env, Hono, MiddlewareHandler } from 'hono'
import type { ConnectorHostLinks } from './host-links.js'
import type { RateLimiter } from './rate-limiter.js'
import type { ConnectorSignInRequests } from './sign-in-requests.js'
import { codeEntryPage, confirmPage, machinesPage, messagePage } from './web-pages.js'
import type { ConnectorWebSignIn, WebSession } from './web-sign-in.js'

async function readForm(context: Context): Promise<Record<string, string>> {
  const form = await context.req.parseBody().catch(() => ({}))
  return Object.fromEntries(
    Object.entries(form).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : []))
  )
}

// /host-login approves a machine's code and /machines lists and revokes the account's machines.
export function registerWebRoutes<E extends Env>(
  app: Hono<E>,
  deps: {
    web: ConnectorWebSignIn
    signIns: ConnectorSignInRequests
    hostLinks: ConnectorHostLinks
    now: () => number
    limitUnauthenticated: MiddlewareHandler
    limitBody: MiddlewareHandler
    codeAttempts: RateLimiter
  }
): void {
  const { web, signIns, hostLinks, now, limitUnauthenticated, limitBody, codeAttempts } = deps
  // Browser pages: Orca web sign-in first, then a CSRF token bound to that session on every form.
  const browserSession = async (
    context: Context,
    returnTo: '/host-login' | '/machines',
    form?: Record<string, string>
  ): Promise<WebSession | Response> => {
    const session = web.session(context)
    if (!session) return web.begin(context, returnTo)
    if (form && !web.csrfMatches(context, form.csrf ?? '')) {
      return context.html(messagePage('Request expired', 'Reload the page and try again.'), 403)
    }
    return session
  }

  app.get('/auth/callback', limitUnauthenticated, (context) => web.complete(context))

  app.get('/host-login', limitUnauthenticated, async (context) => {
    const session = await browserSession(context, '/host-login')
    if (session instanceof Response) return session
    return context.html(codeEntryPage({ email: session.account.email, csrf: session.csrf }))
  })

  app.post('/host-login', limitUnauthenticated, limitBody, async (context) => {
    const form = await readForm(context)
    const session = await browserSession(context, '/host-login', form)
    if (session instanceof Response) return session
    const page = { email: session.account.email, csrf: session.csrf }
    if (!codeAttempts.allow(session.account.id)) {
      return context.html(
        codeEntryPage({ ...page, error: 'Too many attempts. Wait a minute and try again.' }),
        429
      )
    }
    const userCode = form.userCode ?? ''
    const pending = await signIns.findPending(userCode)
    if (!pending) {
      return context.html(
        codeEntryPage({ ...page, error: 'That code is not valid or has expired.' }),
        404
      )
    }
    return context.html(confirmPage({ csrf: session.csrf, userCode, pending, now: now() }))
  })

  app.post('/host-login/decision', limitUnauthenticated, limitBody, async (context) => {
    const form = await readForm(context)
    const session = await browserSession(context, '/host-login', form)
    if (session instanceof Response) return session
    const decision = await signIns.decide(
      form.userCode ?? '',
      session.account,
      form.decision === 'allow'
    )
    const again = { href: '/host-login', label: 'Enter another code' }
    switch (decision) {
      case 'approved':
        return context.html(
          messagePage('Connected', 'Your Orca finishes signing in by itself. You can close this page.')
        )
      case 'denied':
        return context.html(messagePage('Denied', 'Your Orca will stop waiting for approval.'))
      case 'key_linked_elsewhere':
        return context.html(
          messagePage('Not connected', 'This machine is already connected to another Orca account.'),
          409
        )
      case 'not_found':
        return context.html(
          messagePage('Not connected', 'That code is not valid or has expired.', again),
          404
        )
    }
  })

  app.get('/machines', limitUnauthenticated, async (context) => {
    const session = await browserSession(context, '/machines')
    if (session instanceof Response) return session
    return context.html(
      machinesPage({
        email: session.account.email,
        csrf: session.csrf,
        hosts: await hostLinks.listForAccount(session.account.id)
      })
    )
  })

  app.post('/v1/account/hosts/:hostId/revoke', limitUnauthenticated, limitBody, async (context) => {
    const form = await readForm(context)
    const session = await browserSession(context, '/machines', form)
    if (session instanceof Response) return session
    await hostLinks.revoke(session.account.id, context.req.param('hostId'))
    return context.redirect('/machines', 303)
  })

}

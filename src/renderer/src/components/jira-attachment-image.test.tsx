// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JiraAttachmentImage } from './jira-attachment-image'

const { acquire, release } = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }))
vi.mock('@/runtime/runtime-jira-image-cache', () => ({
  acquireJiraImageUrl: acquire,
  hasCachedJiraImage: () => false,
  onJiraImageCacheInvalidated: () => () => {}
}))
const target = { kind: 'environment' as const, environmentId: 'first-host' }
beforeEach(() => {
  acquire.mockReset()
  release.mockReset()
})
afterEach(cleanup)

it('removes the previous image immediately when its mounted owner or reference changes', async () => {
  acquire
    .mockResolvedValueOnce({ url: 'blob:first', release })
    .mockImplementationOnce(() => new Promise(() => {}))
  const view = render(
    <JiraAttachmentImage target={target} reference="first" alt="shot" compact={false} />
  )
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:first'))
  view.rerender(
    <JiraAttachmentImage
      target={{ kind: 'environment', environmentId: 'second-host' }}
      reference="second"
      alt="shot"
      compact={false}
    />
  )
  expect(screen.queryByRole('img')).toBeNull()
  expect(release).toHaveBeenCalledOnce()
})

it('lets a new reference load after the previous reference failed', async () => {
  acquire
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValueOnce({ url: 'blob:second', release })
  const view = render(
    <JiraAttachmentImage target={target} reference="first" alt="shot" compact={false} />
  )
  await waitFor(() => expect(acquire).toHaveBeenCalledOnce())
  await new Promise((resolve) => setTimeout(resolve, 0))
  view.rerender(
    <JiraAttachmentImage target={target} reference="second" alt="shot" compact={false} />
  )
  await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:second'))
})

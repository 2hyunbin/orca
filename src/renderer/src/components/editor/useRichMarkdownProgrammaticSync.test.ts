// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { useRichMarkdownProgrammaticSync } from './useRichMarkdownProgrammaticSync'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  createRichMarkdownEditorCodec,
  type RichMarkdownEditorCodec
} from './rich-markdown-source-transport'
import {
  createRichMarkdownHtmlSuperscriptLinkContext,
  type RichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { notifyStaleViewEditRejected } from './editor-stale-view-edit'

vi.mock('./editor-stale-view-edit', () => ({ notifyStaleViewEditRejected: vi.fn() }))

function buildEditor(
  codec: RichMarkdownEditorCodec,
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext,
  markdown: string
): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext
    }),
    content: encodeRawMarkdownHtmlForRichEditor(markdown, codec, { htmlSuperscriptLinks: true }),
    contentType: 'markdown'
  })
}

describe('useRichMarkdownProgrammaticSync external-reload baseline adoption (#6080)', () => {
  it('adopts externally-canonicalized bytes as the reconciliation baseline without a reload', () => {
    const codec = createRichMarkdownEditorCodec()
    const htmlSuperscriptLinkContext = createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '',
      worktreeId: '',
      worktreeRoot: null,
      sourceOwner: { kind: 'unknown' as const }
    })
    // The editor currently shows emphasis loaded from the original `_old_` source;
    // its canonical (getMarkdown) form is `*old*` with no trailing newline.
    const canonical = '# T\n\n*old*'
    const editor = buildEditor(codec, htmlSuperscriptLinkContext, canonical)
    expect(editor.getMarkdown()).toBe(canonical)

    // Refs still reflect the ORIGINAL non-canonical source bytes on disk.
    const lastCommittedMarkdownRef = { current: '# T\n\n_old_' }
    const originalSourceRef = { current: '# T\n\n_old_' }
    const baseCanonicalRef = { current: canonical }
    const isApplyingProgrammaticUpdateRef = { current: false }

    try {
      // An external tool rewrites disk to the canonical bytes (same semantics,
      // new byte-level style). The doc already renders them, so no reload — but
      // the reconciliation baseline must still be refreshed to the new bytes.
      renderHook(() =>
        useRichMarkdownProgrammaticSync({
          codec,
          content: canonical,
          docLinkMenuSetter: vi.fn(),
          editor,
          fileId: 'f1',
          filePath: '/repo/README.md',
          isApplyingProgrammaticUpdateRef,
          lastCommittedMarkdownRef,
          originalSourceRef,
          baseCanonicalRef,
          markdownDocuments: undefined,
          rootRef: { current: null },
          runtimeTarget: { kind: 'local' },
          serializeTimerRef: { current: null },
          slashMenuSetter: vi.fn(),
          worktreeId: 'w1',
          worktreeRoot: null
        })
      )

      // Without the fix these stay stale at `_old_`, and the next edit would
      // rewrite the file back to `_old_`, silently undoing the external change.
      expect(lastCommittedMarkdownRef.current).toBe(canonical)
      expect(originalSourceRef.current).toBe(canonical)
      expect(baseCanonicalRef.current).toBe(canonical)
    } finally {
      editor.destroy()
    }
  })
})

describe('useRichMarkdownProgrammaticSync stale pending edit', () => {
  function renderPane(paneText: string, pendingCommit: (() => void) | null) {
    const codec = createRichMarkdownEditorCodec()
    const editor = buildEditor(
      codec,
      createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '',
        worktreeId: '',
        worktreeRoot: null,
        sourceOwner: { kind: 'unknown' as const }
      }),
      paneText
    )
    const serializeTimerRef = {
      current: pendingCommit ? window.setTimeout(pendingCommit, 300) : null
    }
    const hook = renderHook(
      ({ content }: { content: string }) =>
        useRichMarkdownProgrammaticSync({
          codec,
          content,
          docLinkMenuSetter: vi.fn(),
          editor,
          fileId: 'f1',
          filePath: '/repo/README.md',
          isApplyingProgrammaticUpdateRef: { current: false },
          lastCommittedMarkdownRef: { current: 'base' },
          originalSourceRef: { current: 'base' },
          baseCanonicalRef: { current: 'base' },
          markdownDocuments: undefined,
          rootRef: { current: null },
          runtimeTarget: { kind: 'local' },
          serializeTimerRef,
          slashMenuSetter: vi.fn(),
          worktreeId: 'w1',
          worktreeRoot: null
        }),
      { initialProps: { content: 'base' } }
    )
    return { editor, hook, serializeTimerRef }
  }

  it('rejects a split pane pending edit once the other pane replaced the shared text', () => {
    vi.useFakeTimers()
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const commitPaneB = vi.fn()
    // Pane B typed "pane b" over "base" and is waiting out its serialize delay.
    const { editor, hook, serializeTimerRef } = renderPane('pane b', commitPaneB)
    try {
      hook.rerender({ content: 'pane a' })
      vi.advanceTimersByTime(300)

      expect(commitPaneB).not.toHaveBeenCalled()
      expect(serializeTimerRef.current).toBeNull()
      expect(notifyStaleViewEditRejected).toHaveBeenCalledOnce()
      expect(editor.getMarkdown()).toBe('pane a')
    } finally {
      editor.destroy()
      vi.useRealTimers()
    }
  })

  it('re-syncs silently when the pane had no pending edit', () => {
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const { editor, hook } = renderPane('base', null)
    try {
      hook.rerender({ content: 'pane a' })
      expect(notifyStaleViewEditRejected).not.toHaveBeenCalled()
      expect(editor.getMarkdown()).toBe('pane a')
    } finally {
      editor.destroy()
    }
  })
})

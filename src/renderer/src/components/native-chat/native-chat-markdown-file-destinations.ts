import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../shared/native-chat-href-routing'
import { formatFileLinkLocation } from '../../../../shared/file-link-location'

type MarkdownNode = {
  type: string
  url?: string
  children?: MarkdownNode[]
}

const SCHEME_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/

/**
 * Sanitize keeps only the protocols it knows, so a `sandbox:` link or a `sandbox:`/`file:` image
 * naming a file loses its address before any chat code sees it. Rewrite those destinations to the
 * chat's own file hrefs first; the existing file link and image paths then open them on the
 * chat's host. Web links and plain paths are left as written.
 */
function rewriteFileDestinations(node: MarkdownNode): void {
  if (
    (node.type === 'link' || node.type === 'image') &&
    node.url &&
    SCHEME_PREFIX_PATTERN.test(node.url)
  ) {
    const route = routeNativeChatHref(node.url)
    if (route.kind === 'file') {
      node.url =
        node.type === 'image'
          ? createNativeChatFileHref(route.pathText, 'literal')
          : createNativeChatFileHref(formatFileLinkLocation(route))
    }
  }
  for (const child of node.children ?? []) {
    rewriteFileDestinations(child)
  }
}

export function remarkNativeChatFileDestinations(): (tree: MarkdownNode) => void {
  return (tree) => rewriteFileDestinations(tree)
}

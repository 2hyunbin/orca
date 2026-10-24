import type { JournalSelectionStorage } from './journal-selection-storage'

export type SelectionCandidate = {
  key: string
  rank: number
  ordinal: number
  time: number
}
type Summary = { first: SelectionCandidate; best?: SelectionCandidate }
type Node = {
  value: SelectionCandidate
  left?: string
  right?: string
  height: number
  summary: Summary
}

function merge(a: Summary | undefined, b: Summary | undefined): Summary | undefined {
  if (!a) {
    return b
  }
  if (!b) {
    return a
  }
  const first = a.first.ordinal < b.first.ordinal ? a.first : b.first
  const x = a.best
  const y = b.best
  const best = !x
    ? y
    : !y
      ? x
      : y.time < x.time || (y.time === x.time && y.ordinal < x.ordinal)
        ? y
        : x
  return { first, best }
}

function summary(value: SelectionCandidate): Summary {
  return { first: value, ...(value.time === value.time ? { best: value } : {}) }
}

function winner(value: Summary | undefined): SelectionCandidate | undefined {
  return value?.first.time !== value?.first.time ? value?.first : value?.best
}

function compare(a: SelectionCandidate, b: SelectionCandidate): number {
  return a.rank - b.rank || a.ordinal - b.ordinal
}

/** AVL suffix-min over original numeric position and submission-lifetime order. */
export class JournalSelectionTree {
  private readonly roots: Map<string, string>
  private readonly nodes: Map<string, Node>
  constructor(storage: JournalSelectionStorage) {
    this.roots = storage.map('treeRoots')
    this.nodes = storage.map('treeNodes')
  }

  private address(tree: string, key: string): string {
    return JSON.stringify([tree, key])
  }

  private node(tree: string, key: string | undefined): Node | undefined {
    return key === undefined ? undefined : this.nodes.get(this.address(tree, key))
  }

  private height(tree: string, key: string | undefined): number {
    return this.node(tree, key)?.height ?? 0
  }

  private save(tree: string, node: Node): string {
    const left = this.node(tree, node.left)
    const right = this.node(tree, node.right)
    const value = {
      ...node,
      height: 1 + Math.max(left?.height ?? 0, right?.height ?? 0),
      summary: merge(merge(left?.summary, summary(node.value)), right?.summary)!
    }
    this.nodes.set(this.address(tree, node.value.key), value)
    return node.value.key
  }

  private rotate(tree: string, node: Node, left: boolean): string {
    const pivot = this.node(tree, left ? node.right : node.left)!
    const changed = left ? { ...node, right: pivot.left } : { ...node, left: pivot.right }
    const key = this.save(tree, changed)
    return this.save(tree, left ? { ...pivot, left: key } : { ...pivot, right: key })
  }

  private balance(tree: string, node: Node): string {
    const delta = this.height(tree, node.left) - this.height(tree, node.right)
    if (delta > 1) {
      const left = this.node(tree, node.left)!
      if (this.height(tree, left.left) < this.height(tree, left.right)) {
        node = { ...node, left: this.rotate(tree, left, true) }
      }
      return this.rotate(tree, node, false)
    }
    if (delta < -1) {
      const right = this.node(tree, node.right)!
      if (this.height(tree, right.right) < this.height(tree, right.left)) {
        node = { ...node, right: this.rotate(tree, right, false) }
      }
      return this.rotate(tree, node, true)
    }
    return this.save(tree, node)
  }

  private insert(tree: string, root: string | undefined, value: SelectionCandidate): string {
    const node = this.node(tree, root)
    if (!node) {
      return this.save(tree, { value, height: 1, summary: summary(value) })
    }
    return this.balance(
      tree,
      compare(value, node.value) < 0
        ? { ...node, left: this.insert(tree, node.left, value) }
        : { ...node, right: this.insert(tree, node.right, value) }
    )
  }

  private remove(
    tree: string,
    root: string | undefined,
    value: SelectionCandidate
  ): string | undefined {
    const node = this.node(tree, root)
    if (!node) {
      return undefined
    }
    const order = compare(value, node.value)
    if (order !== 0) {
      return this.balance(
        tree,
        order < 0
          ? { ...node, left: this.remove(tree, node.left, value) }
          : { ...node, right: this.remove(tree, node.right, value) }
      )
    }
    if (!node.left || !node.right) {
      this.nodes.delete(this.address(tree, node.value.key))
      return node.left ?? node.right
    }
    let successor = this.node(tree, node.right)!
    while (successor.left) {
      successor = this.node(tree, successor.left)!
    }
    const right = this.remove(tree, node.right, successor.value)
    this.nodes.delete(this.address(tree, node.value.key))
    return this.balance(tree, { ...node, value: successor.value, right })
  }

  update(tree: string, key: string, value: SelectionCandidate | undefined): void {
    let root = this.roots.get(tree)
    const previous = this.node(tree, key)?.value
    if (previous) {
      root = this.remove(tree, root, previous)
    }
    if (value) {
      root = this.insert(tree, root, value)
    }
    if (root === undefined) {
      this.roots.delete(tree)
    } else {
      this.roots.set(tree, root)
    }
  }

  minimum(tree: string, floor?: number): SelectionCandidate | undefined {
    let node = this.node(tree, this.roots.get(tree))
    if (floor === undefined) {
      return winner(node?.summary)
    }
    let result: Summary | undefined
    while (node) {
      if (node.value.rank > floor) {
        result = merge(result, merge(summary(node.value), this.node(tree, node.right)?.summary))
        node = this.node(tree, node.left)
      } else {
        node = this.node(tree, node.right)
      }
    }
    return winner(result)
  }

  next(
    tree: string,
    after?: Pick<SelectionCandidate, 'rank' | 'ordinal'>
  ): SelectionCandidate | undefined {
    let node = this.node(tree, this.roots.get(tree))
    let result: SelectionCandidate | undefined
    while (node) {
      const greater =
        !after ||
        node.value.rank > after.rank ||
        (node.value.rank === after.rank && node.value.ordinal > after.ordinal)
      if (greater) {
        result = node.value
        node = this.node(tree, node.left)
      } else {
        node = this.node(tree, node.right)
      }
    }
    return result
  }

  candidate(tree: string, key: string): SelectionCandidate | undefined {
    return this.node(tree, key)?.value
  }

  heightOf(tree: string): number {
    return this.node(tree, this.roots.get(tree))?.height ?? 0
  }
}

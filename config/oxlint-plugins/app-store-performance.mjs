const ALLOCATING_METHODS = new Set([
  'filter',
  'flat',
  'flatMap',
  'map',
  'toReversed',
  'toSorted',
  'toSpliced',
  'with'
])
const ALLOCATING_OBJECT_STATICS = new Set([
  'assign',
  'create',
  'entries',
  'fromEntries',
  'keys',
  'values'
])
const FUNCTION_NODES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression'
])

function identifierName(node) {
  return node?.type === 'Identifier' ? node.name : null
}

function propertyName(node) {
  if (node?.type !== 'MemberExpression') {
    return null
  }
  if (!node.computed) {
    return identifierName(node.property)
  }
  return node.property?.type === 'Literal' && typeof node.property.value === 'string'
    ? node.property.value
    : null
}

function functionNode(node) {
  return FUNCTION_NODES.has(node?.type) ? node : null
}

function returnedExpressions(selector) {
  if (!functionNode(selector)) {
    return []
  }
  if (selector.body.type !== 'BlockStatement') {
    return [selector.body]
  }
  const expressions = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return
    }
    if (node !== selector.body && FUNCTION_NODES.has(node.type)) {
      return
    }
    if (node.type === 'ReturnStatement') {
      if (node.argument) {
        expressions.push(node.argument)
      }
      return
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'parent') {
        continue
      }
      if (Array.isArray(child)) {
        child.forEach(visit)
      } else {
        visit(child)
      }
    }
  }
  visit(selector.body)
  return expressions
}

function unwrapShallowSelector(selector, shallowHooks) {
  if (
    selector?.type === 'CallExpression' &&
    selector.callee.type === 'Identifier' &&
    shallowHooks.has(selector.callee.name)
  ) {
    return { selector: selector.arguments[0], shallow: true }
  }
  return { selector, shallow: false }
}

function isIdentitySelector(selector) {
  const parameter = functionNode(selector)?.params[0]
  if (parameter?.type !== 'Identifier') {
    return false
  }
  return returnedExpressions(selector).some(
    (expression) => expression.type === 'Identifier' && expression.name === parameter.name
  )
}

/**
 * `everyBranch` decides how a conditional counts. An inline selector is flagged
 * when ANY branch allocates; a helper the selector delegates to must allocate on
 * EVERY branch, so the `cache.get(k) ?? build(state)` identity-caching shape is
 * not a false positive.
 */
function allocates(expression, everyBranch) {
  const branches =
    expression?.type === 'ConditionalExpression'
      ? [expression.consequent, expression.alternate]
      : expression?.type === 'LogicalExpression'
        ? [expression.left, expression.right]
        : null
  if (branches) {
    return everyBranch
      ? branches.every((branch) => allocates(branch, true))
      : branches.some((branch) => allocates(branch, false))
  }
  if (
    expression?.type === 'ArrayExpression' ||
    expression?.type === 'ObjectExpression' ||
    expression?.type === 'NewExpression'
  ) {
    return true
  }
  if (expression?.type !== 'CallExpression') {
    return false
  }
  const callee = expression.callee
  const method = propertyName(callee)
  return (
    ALLOCATING_METHODS.has(method) ||
    (identifierName(callee.object) === 'Object' && ALLOCATING_OBJECT_STATICS.has(method))
  )
}

function isAllocatingExpression(expression) {
  return allocates(expression, false)
}

// Project-local zustand hooks follow the use<Name>Store convention; React's
// useSyncExternalStore matches that shape but is not a store subscription.
const STORE_HOOK_NAME = /^use[A-Z][A-Za-z0-9]*Store$/
const NON_STORE_HOOKS = new Set(['useSyncExternalStore'])

function isLocalModuleSource(source) {
  return typeof source === 'string' && (source.startsWith('.') || source.startsWith('@/'))
}

/** Module scope only: a component-local helper must not shadow a same-named import. */
function isModuleScope(node) {
  const parent = node.parent
  return (
    parent?.type === 'Program' ||
    (parent?.type === 'ExportNamedDeclaration' && parent.parent?.type === 'Program')
  )
}

/** Records module-scope `const selectX = (state) => ...` so identifier selectors resolve. */
function recordNamedSelector(node, state) {
  if (!isModuleScope(node)) {
    return
  }
  const declared =
    node.type === 'FunctionDeclaration'
      ? [[node.id, node]]
      : node.declarations.map((declarator) => [declarator.id, declarator.init])
  for (const [id, initializer] of declared) {
    const name = identifierName(id)
    if (name && functionNode(initializer)) {
      state.namedSelectors.set(name, initializer)
    }
  }
}

/** Inline function, or a module-scope selector referenced by name. */
function resolveSelector(argument, state) {
  return functionNode(argument) ?? state.namedSelectors.get(identifierName(argument)) ?? null
}

/**
 * One hop: a selector that delegates to a module-scope helper is the idiomatic
 * shape here, and neither the inline-body check nor a reviewer reading the call
 * site can see what that helper returns. An unresolvable helper is left alone.
 */
function expandThroughNamedHelper(expression, state) {
  const helper =
    expression?.type === 'CallExpression'
      ? state.namedSelectors.get(identifierName(expression.callee))
      : undefined
  const returned = helper ? returnedExpressions(helper) : []
  return returned.length > 0 && returned.every((entry) => allocates(entry, true))
    ? returned
    : [expression]
}

function createRuleState() {
  return {
    appStoreHooks: new Set(),
    shallowHooks: new Set(),
    namedSelectors: new Map(),
    weakMaps: new Set(),
    deferredCalls: []
  }
}

function recordImports(node, state) {
  const source = node.source?.value
  for (const specifier of node.specifiers) {
    if (specifier.type !== 'ImportSpecifier') {
      continue
    }
    const imported = identifierName(specifier.imported)
    const localName = identifierName(specifier.local)
    if (!imported || !localName) {
      continue
    }
    if (source === 'zustand/react/shallow' && imported === 'useShallow') {
      state.shallowHooks.add(localName)
    }
    // useAppStore is the app store wherever it is re-exported from; sibling
    // stores are trusted by naming convention only when they come from this codebase.
    if (
      STORE_HOOK_NAME.test(imported) &&
      !NON_STORE_HOOKS.has(imported) &&
      (imported === 'useAppStore' || isLocalModuleSource(source))
    ) {
      state.appStoreHooks.add(localName)
    }
  }
}

function isAppStoreCall(node, state) {
  return (
    node.callee.type === 'Identifier' &&
    state.appStoreHooks.has(node.callee.name) &&
    node.optional !== true
  )
}

function requireSelectorRule() {
  const state = createRuleState()
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    CallExpression(node) {
      if (isAppStoreCall(node, state) && node.arguments.length === 0) {
        this.report({
          node,
          message:
            'Pass a selector to useAppStore so the component does not rerender for every store write.'
        })
      }
    }
  }
}

/**
 * Selector arguments are collected during traversal and judged at Program:exit so a
 * selector hoisted below its call site still resolves.
 */
function deferredSelectorRule(inspect) {
  const state = createRuleState()
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    FunctionDeclaration(node) {
      recordNamedSelector(node, state)
    },
    VariableDeclaration(node) {
      recordNamedSelector(node, state)
      if (isModuleScope(node)) {
        for (const entry of node.declarations) {
          if (
            entry.init?.type === 'NewExpression' &&
            identifierName(entry.init.callee) === 'WeakMap'
          ) {
            state.weakMaps.add(identifierName(entry.id))
          }
        }
      }
    },
    CallExpression(node) {
      if (isAppStoreCall(node, state)) {
        state.deferredCalls.push(node)
      }
    },
    'Program:exit'() {
      for (const node of state.deferredCalls) {
        const { selector: argument, shallow } = unwrapShallowSelector(
          node.arguments[0],
          state.shallowHooks
        )
        const report = inspect({
          selector: resolveSelector(argument, state),
          shallow,
          state
        })
        if (report) {
          this.report(report)
        }
      }
    }
  }
}

function noIdentitySelectorRule() {
  return deferredSelectorRule(({ selector }) =>
    isIdentitySelector(selector)
      ? {
          node: selector,
          message:
            'Select the smallest required fields instead of subscribing to the entire app store.'
        }
      : null
  )
}

function noFreshSelectorResultRule() {
  return deferredSelectorRule(({ selector, shallow, state }) => {
    if (shallow || !selector) {
      return null
    }
    const freshResult = returnedExpressions(selector)
      .flatMap((expression) => expandThroughNamedHelper(expression, state))
      .find(isAllocatingExpression)
    return freshResult
      ? {
          node: freshResult,
          message:
            'This selector returns a fresh reference on every store write; select a stable field, cache the result, or use useShallow.'
        }
      : null
  })
}

/** useShallow compares one level deep, so a fresh reference nested inside its result never matches. */
function nestedFreshValues(expression) {
  if (expression?.type === 'ObjectExpression') {
    return expression.properties
      .map((property) => (property.type === 'Property' ? property.value : null))
      .filter(Boolean)
  }
  if (expression?.type === 'ArrayExpression') {
    return expression.elements.filter(Boolean)
  }
  return []
}

function noNestedFreshUnderShallowRule() {
  return deferredSelectorRule(({ selector, shallow, state }) => {
    if (!shallow || !selector) {
      return null
    }
    const nestedFresh = returnedExpressions(selector)
      .flatMap((expression) => expandThroughNamedHelper(expression, state))
      .flatMap(nestedFreshValues)
      .flatMap((expression) => expandThroughNamedHelper(expression, state))
      .find(isAllocatingExpression)
    return nestedFresh
      ? {
          node: nestedFresh,
          message:
            'useShallow compares only one level deep, so this nested fresh reference changes on every store write and defeats the memo; project the primitives the component actually renders.'
        }
      : null
  })
}

/** Small state maps and imported helpers are deliberately outside this rule's scope. */
const SCANNED_MAPS = new Set([
  'tabsByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'layoutByWorktree',
  'terminalLayoutsByTabId',
  'worktreesByRepo'
])

/** Walk one function body, including conditional branches, without descending into closures. */
function walkBody(node, visit) {
  if (!node || typeof node !== 'object' || FUNCTION_NODES.has(node.type)) {
    return
  }
  visit(node)
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') {
      continue
    }
    if (Array.isArray(child)) {
      child.forEach((entry) => walkBody(entry, visit))
    } else {
      walkBody(child, visit)
    }
  }
}

function parameterNames(parameter) {
  const names = new Set()
  walkBody(parameter, (node) => {
    if (
      node.type === 'Identifier' &&
      !(node.parent?.type === 'Property' && node.parent.key === node && !node.parent.computed)
    ) {
      names.add(node.name)
    }
  })
  return names
}

function noStateIgnoringSelectorRule() {
  return deferredSelectorRule(({ selector }) => {
    if (!selector) {
      return null
    }
    const names = parameterNames(selector.params[0])
    let referenced = false
    // References inside nested callbacks still depend on the selector's snapshot.
    const visit = (node) => {
      if (!node || typeof node !== 'object') {
        return
      }
      if (
        node.type === 'Identifier' &&
        names.has(node.name) &&
        !(
          node.parent?.type === 'MemberExpression' &&
          node.parent.property === node &&
          !node.parent.computed
        ) &&
        !(node.parent?.type === 'Property' && node.parent.key === node && !node.parent.computed)
      ) {
        referenced = true
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === 'parent') {
          continue
        }
        if (Array.isArray(child)) {
          child.forEach(visit)
        } else {
          visit(child)
        }
      }
    }
    visit(selector.body)
    return referenced
      ? null
      : {
          node: selector,
          message:
            'This store selector ignores its state; read the supplied snapshot instead of doing state-independent work on every write.'
        }
  })
}

function scansTabMap(selector, state, depth = 0) {
  const aliases = new Set()
  const isMap = (node) => SCANNED_MAPS.has(propertyName(node)) || aliases.has(identifierName(node))
  let scan = null
  let cached = false
  const helpers = []
  walkBody(selector.body, (node) => {
    if (node.type === 'VariableDeclarator' && isMap(node.init)) {
      aliases.add(identifierName(node.id))
    }
    if (
      node.type === 'BinaryExpression' &&
      ['===', '!=='].includes(node.operator) &&
      (isMap(node.left) || isMap(node.right))
    ) {
      cached = true
    }
    if (node.type === 'CallExpression') {
      const method = propertyName(node.callee)
      if (
        method === 'get' &&
        state.weakMaps.has(identifierName(node.callee.object)) &&
        node.arguments.some(isMap)
      ) {
        cached = true
      }
      if (
        identifierName(node.callee.object) === 'Object' &&
        ['keys', 'values', 'entries'].includes(method) &&
        isMap(node.arguments[0])
      ) {
        scan ??= node
      }
      const helper = state.namedSelectors.get(identifierName(node.callee))
      if (helper) {
        helpers.push(helper)
      }
    }
    if (node.type === 'ForInStatement' && isMap(node.right)) {
      scan ??= node
    }
  })
  if (cached) {
    return null
  }
  if (scan || depth === 1) {
    return scan
  }
  for (const helper of helpers) {
    const found = scansTabMap(helper, state, depth + 1)
    if (found) {
      return found
    }
  }
  return null
}

function noTabMapScanInSelectorRule() {
  return deferredSelectorRule(({ selector, state }) => {
    const scan = selector && scansTabMap(selector, state)
    return scan
      ? {
          node: scan,
          message:
            'Do not enumerate tabsByWorktree, unifiedTabsByWorktree, groupsByWorktree, browserTabsByWorktree, browserPagesByWorkspace, layoutByWorktree, terminalLayoutsByTabId, or worktreesByRepo on every selector run; cache an index by map identity.'
        }
      : null
  })
}

function bindContext(createVisitors) {
  return (context) => {
    const visitors = createVisitors()
    for (const [nodeType, visit] of Object.entries(visitors)) {
      visitors[nodeType] = visit.bind(context)
    }
    return visitors
  }
}

export default {
  meta: { name: 'app-store-performance' },
  rules: {
    'no-state-ignoring-selector': { create: bindContext(noStateIgnoringSelectorRule) },
    'no-tab-map-scan-in-selector': { create: bindContext(noTabMapScanInSelectorRule) },
    'require-selector': { create: bindContext(requireSelectorRule) },
    'no-identity-selector': { create: bindContext(noIdentitySelectorRule) },
    'no-fresh-selector-result': { create: bindContext(noFreshSelectorResultRule) },
    'no-nested-fresh-under-shallow': { create: bindContext(noNestedFreshUnderShallowRule) }
  }
}

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

/** Resolve the binding at the use site, including nested lexical shadows. */
function variableFor(node, state) {
  const name = identifierName(node)
  for (let scope = name && state.sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.set.get(name)
    if (variable) {
      return variable
    }
  }
  return null
}

/** Inline function, or a module-scope selector referenced by its lexical binding. */
function resolveSelector(argument, state) {
  if (functionNode(argument)) {
    return argument
  }
  const declaration = variableFor(argument, state)?.defs[0]?.node
  if (declaration?.type === 'FunctionDeclaration' && isModuleScope(declaration)) {
    return declaration
  }
  return declaration?.type === 'VariableDeclarator' && isModuleScope(declaration.parent)
    ? functionNode(declaration.init)
    : null
}

/**
 * One hop: a selector that delegates to a module-scope helper is the idiomatic
 * shape here, and neither the inline-body check nor a reviewer reading the call
 * site can see what that helper returns. An unresolvable helper is left alone.
 */
function expandThroughNamedHelper(expression, state) {
  const helper =
    expression?.type === 'CallExpression' && expression.callee.type === 'Identifier'
      ? resolveSelector(expression.callee, state)
      : undefined
  const returned = helper ? returnedExpressions(helper) : []
  return returned.length > 0 && returned.every((entry) => allocates(entry, true))
    ? returned
    : [expression]
}

function createRuleState(sourceCode) {
  return {
    appStoreHooks: new Set(),
    shallowHooks: new Set(),
    sourceCode,
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
function deferredSelectorRule(sourceCode, inspect) {
  const state = createRuleState(sourceCode)
  return {
    ImportDeclaration(node) {
      recordImports(node, state)
    },
    VariableDeclaration(node) {
      if (isModuleScope(node)) {
        for (const entry of node.declarations) {
          const variable = variableFor(entry.id, state)
          if (
            variable &&
            entry.init?.type === 'NewExpression' &&
            identifierName(entry.init.callee) === 'WeakMap'
          ) {
            state.weakMaps.add(variable)
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

function noIdentitySelectorRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector }) =>
    isIdentitySelector(selector)
      ? {
          node: selector,
          message:
            'Select the smallest required fields instead of subscribing to the entire app store.'
        }
      : null
  )
}

function noFreshSelectorResultRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector, shallow, state }) => {
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

function noNestedFreshUnderShallowRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector, shallow, state }) => {
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

function noStateIgnoringSelectorRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector }) => {
    if (!selector) {
      return null
    }
    const parameter = selector.params[0]
    const referenced = sourceCode
      .getDeclaredVariables(selector)
      .some(
        (variable) =>
          variable.defs.some(
            (definition) =>
              definition.type === 'Parameter' &&
              definition.name.start >= parameter.start &&
              definition.name.end <= parameter.end
          ) &&
          variable.references.some(
            (reference) => reference.isRead() && reference.identifier.start >= selector.body.start
          )
      )
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
  const aliases = new Map()
  // A map is identified by the receiver's binding and the listed property, not its spelling alone.
  const mapSource = (node) => {
    if (node?.type === 'Identifier') {
      return aliases.get(variableFor(node, state))
    }
    const owner = node?.type === 'MemberExpression' && variableFor(node.object, state)
    return owner && SCANNED_MAPS.has(propertyName(node)) ? [owner, propertyName(node)] : null
  }
  const recordPattern = (pattern, owner) => {
    for (const property of pattern?.type === 'ObjectPattern' ? pattern.properties : []) {
      const name = !property.computed && (identifierName(property.key) ?? property.key?.value)
      const variable = variableFor(property.value, state)
      if (variable && SCANNED_MAPS.has(name)) {
        aliases.set(variable, [owner ?? variable, name])
      }
    }
  }
  recordPattern(selector.params[0])
  const scans = []
  const cached = []
  const helpers = []
  walkBody(selector.body, (node) => {
    if (node.type === 'VariableDeclarator') {
      const map = mapSource(node.init)
      const variable = variableFor(node.id, state)
      if (map && variable) {
        aliases.set(variable, map)
      }
      recordPattern(node.id, variableFor(node.init, state))
    }
    if (node.type === 'BinaryExpression' && ['===', '!=='].includes(node.operator)) {
      const map = mapSource(node.left) ?? mapSource(node.right)
      if (map) {
        cached.push(map)
      }
    }
    if (node.type === 'CallExpression') {
      const method = propertyName(node.callee)
      if (method === 'get' && state.weakMaps.has(variableFor(node.callee.object, state))) {
        const map = mapSource(node.arguments[0])
        if (map) {
          cached.push(map)
        }
      }
      if (
        identifierName(node.callee.object) === 'Object' &&
        ['keys', 'values', 'entries'].includes(method)
      ) {
        const map = mapSource(node.arguments[0])
        if (map) {
          scans.push({ node, map })
        }
      }
      const helper = node.callee.type === 'Identifier' && resolveSelector(node.callee, state)
      if (helper) {
        helpers.push(helper)
      }
    }
    if (node.type === 'ForInStatement') {
      const map = mapSource(node.right)
      if (map) {
        scans.push({ node, map })
      }
    }
  })
  const scan = scans.find(
    ({ map }) => !cached.some(([owner, name]) => owner === map[0] && name === map[1])
  )
  if (scan || depth === 1) {
    return scan?.node ?? null
  }
  for (const helper of helpers) {
    const found = scansTabMap(helper, state, depth + 1)
    if (found) {
      return found
    }
  }
  return null
}

function noTabMapScanInSelectorRule(sourceCode) {
  return deferredSelectorRule(sourceCode, ({ selector, state }) => {
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
    const visitors = createVisitors(context.sourceCode)
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

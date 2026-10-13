import { beforeEach, expect, it } from 'vitest'
import { recordPluginSyntaxFailure, usePluginSyntaxFailureStore } from './plugin-syntax-failures'

beforeEach(() => usePluginSyntaxFailureStore.setState({ failures: {} }))

it('separates equal file paths on different hosts and removes only the retired model', () => {
  const local = 'file:///project/file.typ#host=local'
  const remote = 'file:///project/file.typ#host=ssh'
  const failure = { key: 'syntax:publisher.pack/typst', revision: 'one', reason: 'budget' } as const
  recordPluginSyntaxFailure(local, failure)
  recordPluginSyntaxFailure(remote, { ...failure, reason: 'size' })
  recordPluginSyntaxFailure(local, null)
  expect(usePluginSyntaxFailureStore.getState().failures).toEqual({
    [remote]: { ...failure, reason: 'size', modelUri: remote }
  })
})

it('does not notify subscribers for repeated equivalent failure or absent cleanup', () => {
  const uri = 'file:///project/file.typ#host=local'
  const failure = { key: 'syntax:publisher.pack/typst', revision: 'one', reason: 'load' } as const
  recordPluginSyntaxFailure(uri, failure)
  const before = usePluginSyntaxFailureStore.getState()
  recordPluginSyntaxFailure(uri, { ...failure })
  recordPluginSyntaxFailure('file:///absent.typ', null)
  expect(usePluginSyntaxFailureStore.getState()).toBe(before)
  recordPluginSyntaxFailure(uri, { ...failure, revision: 'two' })
  expect(usePluginSyntaxFailureStore.getState().failures[uri].revision).toBe('two')
})

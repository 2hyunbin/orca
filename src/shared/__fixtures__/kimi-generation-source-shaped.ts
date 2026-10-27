// Source-shaped from official Kimi Code 2.3.1 PromptJsonWriter; not a live CLI capture.
export function sourceShapedKimiOutput(answer?: string): string {
  return [
    { role: 'meta', type: 'system.version', version: '2.3.1' },
    { role: 'assistant', content: 'UserPromptSubmit hook\n\nWorkspace instructions loaded' },
    {
      role: 'assistant',
      content: 'Let me look at the diff.',
      tool_calls: [
        { type: 'function', id: 'tc_1', function: { name: 'Shell', arguments: '{"command":"git diff"}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'tc_1', content: 'diff --git a/file.ts b/file.ts' },
    ...(answer === undefined ? [] : [{ role: 'assistant', content: answer }]),
    {
      role: 'meta', type: 'session.resume_hint', session_id: 'generation-test',
      command: 'kimi -r generation-test', content: 'To resume this session: kimi -r generation-test'
    }
  ].map((message) => JSON.stringify(message)).join('\n')
}

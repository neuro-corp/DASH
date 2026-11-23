import { afterEach, describe, expect, it } from 'bun:test';
import { chatOpenAI } from './openai';
import { agentTools } from '../layers/agent/tools';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sse(frames: unknown[]): Response {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('OpenAI provider tool contract', () => {
  it('sends canonical tool schemas and preserves tool-call IDs in follow-up results', async () => {
    const requests: Array<{ url: string; body: Record<string, any> }> = [];
    let call = 0;
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      call++;
      return call === 1
        ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"query":"foo"}' } }] } }] }])
        : sse([{ choices: [{ delta: { content: 'Found it.' } }] }]);
    }) as unknown as typeof fetch;

    const tools = agentTools.filter(tool => tool.function.name === 'grep');
    const initial = await chatOpenAI('test-key', 'gpt-test', [{ role: 'user', content: 'find foo' }], tools);
    expect(initial.toolCalls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"query":"foo"}' } }]);
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(requests[0]?.body.tools[0]).toEqual(tools[0]);

    const followup = await chatOpenAI('test-key', 'gpt-test', [
      { role: 'user', content: 'find foo' },
      { role: 'assistant', content: '', tool_calls: initial.toolCalls },
      { role: 'tool', tool_call_id: 'call_1', content: '{"success":true}' },
    ], tools);
    expect(followup.content).toBe('Found it.');
    expect(requests[1]?.body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '{"success":true}' });
  });
});

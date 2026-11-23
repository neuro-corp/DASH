import { describe, expect, it } from 'bun:test';
import { ToolRegistry, type ToolDefinitionLike } from './tool-registry';

const definition: ToolDefinitionLike = {
  type: 'function',
  function: {
    name: 'echo_value',
    description: 'Echo a value.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
};

describe('ToolRegistry', () => {
  it('registers, retrieves, lists, validates, executes, and unregisters a canonical tool', async () => {
    const registry = new ToolRegistry<{ prefix: string }>();
    registry.register(definition, ({ value }, context) => `${context.prefix}${value}`);
    expect(registry.has('echo_value')).toBe(true);
    expect(registry.get('echo_value')).toBe(definition);
    expect(registry.getAll()).toEqual([definition]);
    expect(registry.getDefinitions()).toEqual([definition]);
    expect(registry.validate('echo_value', '{"value":"ok"}')).toEqual({ success: true, args: { value: 'ok' } });
    expect(registry.validate('echo_value', '{}').success).toBe(false);
    expect(registry.validate('echo_value', '{"value":5}').success).toBe(false);
    expect(await registry.execute('echo_value', '{"value":"ok"}', { prefix: '>' })).toMatchObject({
      success: true,
      toolName: 'echo_value',
      data: '>ok',
      metadata: { cached: false },
    });
    expect(registry.unregister('echo_value')).toBe(true);
    expect(registry.has('echo_value')).toBe(false);
  });

  it('rejects duplicate names and malformed schemas', () => {
    const registry = new ToolRegistry();
    registry.register(definition, () => 'ok');
    expect(() => registry.register(definition, () => 'again')).toThrow('already registered');
    expect(() => registry.register({
      ...definition,
      function: { ...definition.function, name: 'broken_tool', parameters: { type: 'object', required: ['absent'] } },
    }, () => 'bad')).toThrow('required contains an unknown property');
  });

  it('returns structured errors for unknown tools and handler failures', async () => {
    const registry = new ToolRegistry();
    registry.register(definition, () => { throw new Error('handler failure'); });
    expect(await registry.execute('missing_tool', '{}', undefined)).toMatchObject({ success: false, errorCode: 'unknown_tool' });
    expect(await registry.execute('echo_value', '{"value":"ok"}', undefined)).toMatchObject({ success: false, errorCode: 'tool_failed', error: 'handler failure' });
  });
});

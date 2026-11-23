import { describe, expect, it } from 'bun:test';
import {
  buildCapabilityRegistry,
  findCapabilities,
  formatCapabilityKnowledge,
  formatCapabilityOverview,
  isMutatingTool,
  recoveryForError,
  shouldRecordOperation,
  summarizeToolOperation,
} from './capabilities';
import { agentTools } from './tools';

const registry = buildCapabilityRegistry(agentTools);

describe('capability registry', () => {
  it('derives every registered tool from its actual schema', () => {
    expect(registry.capabilities).toHaveLength(agentTools.length);
    for (const tool of agentTools) {
      const capability = registry.byName.get(tool.function.name);
      expect(capability).toBeDefined();
      expect(capability?.source).toBe('tool-schema');
      expect(capability?.summary.length).toBeGreaterThan(0);
      expect(capability?.useWhen.length).toBeGreaterThan(0);
      expect(capability?.avoidWhen.length).toBeGreaterThan(0);
      expect(capability?.result.length).toBeGreaterThan(0);
      expect(capability?.limitations.length).toBeGreaterThan(0);
      expect(capability?.recovery.length).toBeGreaterThan(0);
      const parameters = tool.function.parameters as { properties?: Record<string, unknown>; required?: readonly string[] } | undefined;
      const schemaArguments = Object.keys(parameters?.properties ?? {}).sort();
      expect(capability?.arguments.map(argument => argument.name).sort()).toEqual(schemaArguments);
      const required = new Set(parameters?.required ?? []);
      for (const argument of capability?.arguments ?? []) {
        expect(argument.required).toBe(required.has(argument.name));
      }
    }
    expect(new Set(registry.capabilities.map(capability => capability.name)).size).toBe(registry.capabilities.length);
  });

  it('keeps side effects and approval aligned with mutating tools', () => {
    expect(isMutatingTool('edit_file')).toBe(true);
    expect(isMutatingTool('read_file')).toBe(false);
    expect(registry.byName.get('edit_file')?.sideEffects).toBe('workspace-write');
    expect(registry.byName.get('delete_file')?.approval).toBe('always');
    expect(registry.byName.get('write_memory')?.sideEffects).toBe('preference-write');
    expect(registry.byName.get('write_memory')?.approval).toBe('always');
    expect(registry.byName.get('web_search')?.sideEffects).toBe('network');
    expect(registry.byName.get('update_task_plan')?.sideEffects).toBe('task-state');
    expect(registry.byName.get('get_task_status')?.sideEffects).toBe('none');
    expect(registry.byName.get('get_check_results')?.sideEffects).toBe('none');
    expect(registry.byName.get('read_many')?.category).toBe('read');
    expect(registry.byName.get('multi_file_edit')?.sideEffects).toBe('workspace-write');
    expect(registry.byName.get('multi_file_edit')?.limitations.join(' ')).toContain('rollback is best-effort');
  });

  it('treats MCP tools as external, approval-gated operations', () => {
    const mcpRegistry = buildCapabilityRegistry([{
      type: 'function',
      function: {
        name: 'mcp_filesystem_read_file',
        description: 'Read a remote file.',
        parameters: { type: 'object', properties: {} },
      },
    }]);
    expect(mcpRegistry.byName.get('mcp_filesystem_read_file')).toMatchObject({
      category: 'external',
      sideEffects: 'network',
      approval: 'always',
    });
    expect(isMutatingTool('mcp_filesystem_read_file')).toBe(true);
    expect(shouldRecordOperation('mcp_filesystem_read_file', false)).toBe(true);
  });

  it('retrieves bounded guidance by tool name, category, and error code', () => {
    expect(findCapabilities(registry, 'edit_file', 1).map(capability => capability.name)).toEqual(['edit_file']);
    const recovery = findCapabilities(registry, 'stale_file', 8);
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.every(capability => capability.recovery.some(entry => entry.code === 'stale_file'))).toBe(true);
    const mutations = findCapabilities(registry, 'mutate', 2);
    expect(mutations).toHaveLength(2);
    expect(mutations.every(capability => capability.category === 'mutate')).toBe(true);
    expect(findCapabilities(registry, 'not-a-real-tool', 5)).toEqual([]);
  });

  it('formats a compact overview without duplicating full descriptions', () => {
    const overview = formatCapabilityOverview(registry);
    for (const tool of agentTools) expect(overview).toContain(tool.function.name);
    const configuredDescriptionChars = agentTools.reduce((sum, tool) => sum + tool.function.description.length, 0);
    expect(overview.length).toBeLessThan(configuredDescriptionChars / 2);
    expect(overview).not.toContain('Atomically create or replace a file. Pass expected_hash');
  });

  it('returns provenance and recovery without unbounded output', () => {
    const capabilities = findCapabilities(registry, 'stale_file', 8);
    const output = formatCapabilityKnowledge('stale_file', capabilities);
    const parsed = JSON.parse(output);
    expect(parsed.source).toBe('tool-schema');
    expect(parsed.errorRecovery.code).toBe('stale_file');
    expect(parsed.capabilities.length).toBeLessThanOrEqual(8);
    expect(output.length).toBeLessThan(12_000);
    expect(recoveryForError('approval_denied')?.recovery).toContain('Do not retry');
    for (const code of [
      'tool_not_available', 'unknown_tool',
      'invalid_arguments', 'text_not_found', 'ambiguous_match', 'overlapping_edits', 'file_not_found',
      'not_a_file', 'file_too_large', 'stale_file', 'approval_denied', 'workspace_boundary', 'write_failed',
      'verification_failed', 'tool_failed', 'cancelled',
    ]) {
      expect(recoveryForError(code)).toBeDefined();
    }
    expect(recoveryForError('unknown_error')).toBeUndefined();
  });

  it('decides which operations belong in execution history', () => {
    expect(shouldRecordOperation('read_file', false)).toBe(false);
    expect(shouldRecordOperation('read_file', true)).toBe(true);
    expect(shouldRecordOperation('edit_file', false)).toBe(true);
    expect(shouldRecordOperation('run_checks', false)).toBe(true);
    expect(shouldRecordOperation('todo_write', false)).toBe(false);
    const operation = summarizeToolOperation(
      'edit_file',
      JSON.stringify({ path: 'src/a.ts' }),
      JSON.stringify({ success: false, errorCode: 'stale_file', message: 'File changed' }),
      true,
    );
    expect(operation.outcome).toBe('fail');
    expect(operation.label).toContain('edit_file');
    expect(operation.label).toContain('src/a.ts');
    expect(operation.detail).toContain('stale_file');
  });
});

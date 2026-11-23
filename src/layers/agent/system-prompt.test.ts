import { describe, expect, it } from 'bun:test';
import systemPrompt from '../../../system-prompt.json';
import { buildCapabilityRegistry } from './capabilities';
import { createAgentSystemMessage } from './system-prompt';
import { agentTools } from './tools';

const registry = buildCapabilityRegistry(agentTools);
const message = createAgentSystemMessage(systemPrompt, registry);

describe('agent system prompt', () => {
  it('uses the capability registry instead of duplicating long tool descriptions', () => {
    expect(message).toContain('You are Dash');
    expect(message).toContain('get_agent_knowledge');
    expect(message).toContain('get_project_map');
    expect(message).toContain('stale');
    for (const tool of agentTools) expect(message).toContain(tool.function.name);
    expect(message).not.toContain('Use offset (1-based) and limit (default 200, max 2000)');
    expect(message).not.toContain('Read a UTF-8 text file from the current workspace in bounded line ranges');
  });

  it('can describe only the tools available for the current task', () => {
    const scoped = createAgentSystemMessage(systemPrompt, buildCapabilityRegistry(
      agentTools.filter(tool => ['read_file', 'edit_file', 'grep'].includes(tool.function.name)),
    ));
    expect(scoped).toContain('read_file');
    expect(scoped).toContain('edit_file');
    expect(scoped).toContain('grep');
    expect(scoped).not.toContain('apply_patch');
    expect(scoped).not.toContain('web_search');
  });

  it('sends the configured efficiency rules and technical guidelines to the model', () => {
    expect(message).toContain('Efficiency rules:');
    expect(message).toContain('skip project-wide typecheck/tests/builds');
    expect(message).toContain('do not call update_task_plan for tasks needing 1-3 steps');
    expect(message).toContain('Never');
    expect(message).toContain('Never repeat an identical failing call');
    expect(message).toContain('read-only guidance unless implementation is explicit');
    expect(message).toContain('search one distinctive term');
    expect(message).toContain('inspect its best match');
  });

  it('prioritizes implementation over read-only investigation for coding requests', () => {
    expect(message).toContain('reading and analysis support the work, but are not the deliverable.');
    expect(message).toContain('inspect enough relevant context to edit safely, then implement rather than investigate only');
    expect(message).toContain('Implement requested code changes in the workspace');
  });

  it('stays compact compared with sending every tool description verbatim', () => {
    expect(message.length).toBeLessThan(12_000);
    expect(Math.ceil(message.length / 4)).toBeLessThan(3_000);
  });

  it('preserves configured custom skills that are not actual tools', () => {
    const custom = createAgentSystemMessage({
      instructions: {
        role: 'Custom agent role',
        skills: ['team_rule: Never edit generated files.'],
      },
    }, registry);
    expect(custom).toContain('Custom agent role');
    expect(custom).toContain('Never edit generated files.');
    expect(custom).toContain('get_agent_knowledge');
  });
});

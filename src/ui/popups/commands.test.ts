import { describe, expect, it } from 'bun:test';
import { COMMANDS, filterCommands } from './commands';

describe('slash command suggestions', () => {
  it('filters suggestions by the typed command prefix', () => {
    expect(filterCommands('/mod').map(command => command.key)).toEqual(['/models']);
    expect(filterCommands('/new').map(command => command.key)).toEqual(['/new']);
  });

  it('does not show the agent mode command in the popup suggestions', () => {
    expect(COMMANDS.some(command => command.key === '/mode')).toBe(false);
  });

  it('exposes MCP server management from the slash menu', () => {
    expect(filterCommands('/mcp').map(command => command.key)).toContain('/mcp');
  });
});

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { callMcpTool, connectMcpServer, mcpServersToAutoConnect, parseMcpAddCommand, parseMcpAddHttpCommand, selectToolsWithinProviderLimit, tokenizeCommandLine } from './mcp';

describe('MCP server configuration helpers', () => {
  it('tokenizes arguments with quoted spaces and Windows paths', () => {
    expect(tokenizeCommandLine('node "server with spaces.js" C:\\Users\\me\\project --flag')).toEqual([
      'node', 'server with spaces.js', 'C:\\Users\\me\\project', '--flag',
    ]);
  });

  it('parses a stdio server add command without invoking a shell', () => {
    expect(parseMcpAddCommand('/mcp add filesystem --env ROOT=C:\\Projects\\demo -- npx -y @modelcontextprotocol/server-filesystem "C:\\Projects\\demo"')).toEqual({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Projects\\demo'],
      env: { ROOT: 'C:\\Projects\\demo' },
    });
    expect(parseMcpAddCommand('/mcp add filesystem npx server')).toBeUndefined();
  });

  it('accepts only HTTP(S) transport URLs', () => {
    expect(parseMcpAddHttpCommand('/mcp add-http remote https://example.com/mcp --header Authorization="Bearer access token"')).toEqual({
      name: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer access token' },
    });
    expect(() => parseMcpAddHttpCommand('/mcp add-http bad file:///tmp/mcp')).toThrow('HTTP or HTTPS');
    expect(() => parseMcpAddHttpCommand('/mcp add-http bad https://example.com/mcp?token=secret')).toThrow('Do not put credentials');
  });

  it('connects to a stdio MCP server, discovers tools, and calls them', async () => {
    const server = await connectMcpServer({
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url))],
    }, process.cwd());
    try {
      const binding = server.tools[0];
      expect(binding?.definition.function.name).toMatch(/^mcp_echo_/);
      expect(binding?.definition.function.parameters).toMatchObject({
        type: 'object',
        required: ['text'],
      });
      const result = JSON.parse(await callMcpTool(server, binding!, '{"text":"hello MCP"}'));
      expect(result).toMatchObject({ success: true, server: 'echo', tool: 'echo_text' });
      expect(result.content).toContainEqual({ type: 'text', text: 'hello MCP' });
      const invalid = JSON.parse(await callMcpTool(server, binding!, '{not-json'));
      expect(invalid).toMatchObject({ success: false, failed: true, errorCode: 'invalid_arguments' });
    } finally {
      await server.client.close();
    }
  });

  it('propagates MCP server-reported tool errors', async () => {
    const binding = {
      serverName: 'echo',
      remoteName: 'fail_tool',
      definition: {
        type: 'function' as const,
        function: { name: 'mcp_echo_fail', description: 'Test failure', parameters: { type: 'object' } },
      },
    };
    const connection = {
      config: { name: 'echo', transport: 'stdio' as const, command: 'fake' },
      tools: [binding],
      client: {
        callTool: async () => ({ isError: true, content: [{ type: 'text' as const, text: 'Product Hunt authorization required.' }] }),
      },
    } as any;
    await expect(callMcpTool(connection, binding, '{}')).rejects.toThrow('Product Hunt authorization required.');
  });

  it('keeps provider tool requests within 64 while reserving slots for relevant MCP tools', () => {
    const coreTools = Array.from({ length: 60 }, (_, index) => ({
      type: 'function' as const,
      function: { name: `core_tool_${index}`, description: 'Core tool', parameters: { type: 'object' } },
    }));
    const mcpBindings = Array.from({ length: 30 }, (_, index) => ({
      serverName: 'ProductHunt',
      remoteName: index === 29 ? 'search_launches' : `other_tool_${index}`,
      definition: {
        type: 'function' as const,
        function: {
          name: `mcp_producthunt_tool_${index}`,
          description: index === 29 ? 'Search Product Hunt launches by query.' : `Unrelated management operation ${index}.`,
          parameters: { type: 'object' },
        },
      },
    }));

    const result = selectToolsWithinProviderLimit(coreTools, mcpBindings, 'Search Product Hunt launches');
    expect(result.tools).toHaveLength(64);
    expect(result.omittedCoreCount).toBe(12);
    expect(result.selectedMcpBindings).toHaveLength(16);
    expect(result.selectedMcpBindings.some(binding => binding.remoteName === 'search_launches')).toBe(true);
    expect(result.omittedMcpCount).toBe(14);
    expect(new Set(result.tools.map(tool => tool.function.name)).size).toBe(64);
  });

  it('auto-connects saved MCP servers unless the user explicitly disabled them', () => {
    const servers = [
      { name: 'legacy-server', transport: 'http' as const, url: 'https://legacy.example/mcp' },
      { name: 'enabled-server', transport: 'http' as const, url: 'https://enabled.example/mcp', enabled: true },
      { name: 'disabled-server', transport: 'http' as const, url: 'https://disabled.example/mcp', enabled: false },
    ];
    expect(mcpServersToAutoConnect(servers).map(server => server.name)).toEqual(['legacy-server', 'enabled-server']);
  });
});

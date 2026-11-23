import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinitionLike } from './capabilities';

export type McpServerConfig = {
  name: string;
  /** Defaults to enabled for compatibility with existing saved configurations. */
  enabled?: boolean;
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export type McpToolBinding = {
  serverName: string;
  remoteName: string;
  definition: ToolDefinitionLike;
};

export type ConnectedMcpServer = {
  config: McpServerConfig;
  client: Client;
  tools: McpToolBinding[];
};

const MAX_TOOL_NAME_LENGTH = 64;

function toolIdentifier(serverName: string, remoteName: string): string {
  const server = serverName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const remote = remoteName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const serverHash = createHash('sha1').update(serverName.toLowerCase()).digest('hex').slice(0, 6);
  const prefix = `mcp_${server.slice(0, 14)}_${serverHash}_`;
  const suffix = createHash('sha1').update(`${serverName.toLowerCase()}:${remoteName}`).digest('hex').slice(0, 6);
  const remoteRoom = MAX_TOOL_NAME_LENGTH - prefix.length - suffix.length - 1;
  return `${prefix}${remote.slice(0, remoteRoom)}_${suffix}`;
}

export function tokenizeCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;
  let started = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (escaping) {
      token += char;
      escaping = false;
      started = true;
      continue;
    }
    if (
      char === '\\'
      && quote !== "'"
      && ['\\', '"', "'", ' ', '\t'].includes(value[index + 1] ?? '')
    ) {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
      continue;
    }
    token += char;
    started = true;
  }
  if (escaping) token += '\\';
  if (quote) throw new Error('Unclosed quote in command arguments.');
  if (started) tokens.push(token);
  return tokens;
}

export function parseMcpAddCommand(input: string): { name: string; command: string; args: string[]; env: Record<string, string> } | undefined {
  const match = /^\/mcp\s+add\s+([a-z0-9._-]{1,48})\s+([\s\S]+)$/i.exec(input.trim());
  if (!match) return undefined;
  const name = match[1]!;
  const tokens = tokenizeCommandLine(match[2]!);
  const separator = tokens.indexOf('--');
  if (separator < 0) return undefined;
  const options = tokens.slice(0, separator);
  const commandTokens = tokens.slice(separator + 1);
  const env: Record<string, string> = {};
  for (let index = 0; index < options.length; index++) {
    if (options[index] !== '--env') throw new Error(`Unknown MCP add option: ${options[index]}.`);
    const pair = options[index + 1] ?? '';
    const split = pair.indexOf('=');
    const key = pair.slice(0, split);
    if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error('MCP environment values must use --env NAME=value.');
    }
    env[key] = pair.slice(split + 1);
    index++;
  }
  const [command, ...args] = commandTokens;
  if (!command) throw new Error('Provide the executable after --.');
  return { name, command, args, env };
}

export function parseMcpAddHttpCommand(input: string): { name: string; url: string; headers: Record<string, string> } | undefined {
  const match = /^\/mcp\s+add-http\s+([a-z0-9._-]{1,48})\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(input.trim());
  if (!match) return undefined;
  const url = new URL(match[2]!);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP URL must use HTTP or HTTPS.');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Do not put credentials in the MCP URL; pass them with --header NAME=value.');
  }
  const options = match[3] ? tokenizeCommandLine(match[3]) : [];
  const headers: Record<string, string> = {};
  for (let index = 0; index < options.length; index++) {
    if (options[index] !== '--header') throw new Error(`Unknown MCP HTTP option: ${options[index]}.`);
    const pair = options[index + 1] ?? '';
    const split = pair.indexOf('=');
    const key = pair.slice(0, split);
    if (split < 1 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) {
      throw new Error('MCP headers must use --header NAME=value.');
    }
    headers[key] = pair.slice(split + 1);
    index++;
  }
  return { name: match[1]!, url: url.toString(), headers };
}

function toolDefinition(server: McpServerConfig, tool: {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[]; [key: string]: unknown };
}): McpToolBinding {
  const name = toolIdentifier(server.name, tool.name);
  return {
    serverName: server.name,
    remoteName: tool.name,
    definition: {
      type: 'function',
      function: {
        name,
        description: `MCP server ${server.name}, tool ${tool.name}. ${tool.description ?? 'External server tool; requires user approval before execution.'}`.trim(),
        parameters: { ...tool.inputSchema, type: 'object' },
      },
    },
  };
}

export async function connectMcpServer(
  config: McpServerConfig,
  workspaceRoot: string,
): Promise<ConnectedMcpServer> {
  if (!/^[a-z0-9._-]{1,48}$/i.test(config.name)) throw new Error('MCP server name must contain 1–48 letters, digits, dots, underscores, or hyphens.');
  const client = new Client({ name: 'dash', version: '1.0.0' }, { capabilities: {} });
  const transport = config.transport === 'http'
    ? new StreamableHTTPClientTransport(new URL(config.url ?? ''), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      })
    : new StdioClientTransport({
        command: config.command ?? '',
        args: config.args ?? [],
        env: config.env,
        cwd: workspaceRoot,
        stderr: 'inherit',
      });
  try {
    if (config.transport !== 'http' && !config.command?.trim()) throw new Error('MCP server command is missing.');
    await client.connect(transport, { timeout: 30_000 });
    const response = await client.listTools(undefined, { timeout: 30_000 });
    const tools = response.tools
      .filter(tool => /^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name))
      .map(tool => toolDefinition(config, tool));
    return { config, client, tools };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export function connectedMcpTools(connections: Iterable<ConnectedMcpServer>): McpToolBinding[] {
  return [...connections].flatMap(connection => connection.tools);
}

export function mcpServersToAutoConnect(servers: readonly McpServerConfig[]): McpServerConfig[] {
  return servers.filter(server => server.enabled !== false);
}

const TOOL_MATCH_STOP_WORDS = new Set([
  'can', 'could', 'please', 'use', 'my', 'the', 'a', 'an', 'for', 'with', 'from', 'about',
  'tool', 'tools', 'mcp', 'server', 'help', 'want', 'need', 'you', 'your', 'this', 'that',
]);

function mcpToolRelevance(binding: McpToolBinding, task: string): number {
  const terms = task.toLowerCase().match(/[a-z0-9_-]{2,}/g) ?? [];
  const name = binding.remoteName.toLowerCase().replace(/[_-]+/g, ' ');
  const description = binding.definition.function.description.toLowerCase();
  const serverName = binding.serverName.toLowerCase().replace(/[_-]+/g, ' ');
  let score = 0;
  for (const rawTerm of terms) {
    if (TOOL_MATCH_STOP_WORDS.has(rawTerm)) continue;
    const term = rawTerm.replace(/[_-]+/g, ' ');
    if (name.includes(term)) score += 8;
    if (description.includes(term)) score += 3;
    if (serverName.includes(term)) score += 1;
  }
  return score;
}

/**
 * Keep provider requests inside the common 64-tool API limit while reserving
 * up to 16 slots for the MCP servers explicitly connected by the user.
 */
export function selectToolsWithinProviderLimit<T extends { function: { name: string } }>(
  coreTools: readonly T[],
  mcpBindings: readonly McpToolBinding[],
  task: string,
  maxTools = 64,
  reservedMcpTools = 16,
): { tools: T[]; selectedMcpBindings: McpToolBinding[]; omittedCoreCount: number; omittedMcpCount: number } {
  const limit = Math.max(1, Math.trunc(maxTools));
  const uniqueCore = coreTools.filter((tool, index, list) => list.findIndex(entry => entry.function.name === tool.function.name) === index);
  const uniqueMcp = mcpBindings.filter((binding, index, list) => (
    list.findIndex(entry => entry.definition.function.name === binding.definition.function.name) === index
  ));
  const mcpReservation = uniqueMcp.length > 0
    ? Math.min(uniqueMcp.length, Math.max(1, Math.min(Math.trunc(reservedMcpTools), limit - 1)))
    : 0;
  const coreLimit = Math.max(0, limit - mcpReservation);
  const selectedCore = uniqueCore.slice(0, coreLimit);
  const availableMcp = Math.max(0, limit - selectedCore.length);
  const rankedMcp = uniqueMcp
    .map((binding, index) => ({ binding, index, score: mcpToolRelevance(binding, task) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, availableMcp)
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.binding);
  const selectedNames = new Set(rankedMcp.map(binding => binding.definition.function.name));
  const selectedMcpBindings = rankedMcp;
  const tools = [
    ...selectedCore,
    ...selectedMcpBindings.map(binding => binding.definition as T),
  ];
  return {
    tools,
    selectedMcpBindings,
    omittedCoreCount: uniqueCore.length - selectedCore.length,
    omittedMcpCount: uniqueMcp.filter(binding => !selectedNames.has(binding.definition.function.name)).length,
  };
}

export async function callMcpTool(
  connection: ConnectedMcpServer,
  binding: McpToolBinding,
  rawArguments: string,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be a JSON object');
    args = parsed as Record<string, unknown>;
  } catch (error) {
    return JSON.stringify({
      success: false,
      failed: true,
      errorCode: 'invalid_arguments',
      message: `Invalid MCP tool arguments: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
    });
  }
  const result = await connection.client.callTool({ name: binding.remoteName, arguments: args }, undefined, { timeout: 120_000 });
  if (result.isError) {
    const message = result.content
      .filter(entry => entry.type === 'text')
      .map(entry => entry.type === 'text' ? entry.text : '')
      .join('\n');
    throw new Error(message || `MCP server ${connection.config.name} reported a tool error.`);
  }
  const output = JSON.stringify({
    success: true,
    server: connection.config.name,
    tool: binding.remoteName,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    content: result.content,
  });
  return output.length <= 30_000 ? output : `${output.slice(0, 30_000)}… [MCP result truncated]`;
}

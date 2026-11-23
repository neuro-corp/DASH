import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server({ name: 'dash-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo_text',
    description: 'Echo a string for MCP transport tests.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async request => ({
  content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }],
}));
await server.connect(new StdioServerTransport());

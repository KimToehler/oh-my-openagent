import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
const server = new Server({ name: 'qa-ctx-shell-stub', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ctx_shell', description: 'QA stub detached shell tool', inputSchema: { type: 'object', properties: { command: { type: 'string' }, run_in_background: { type: 'boolean' }, background_action: { type: 'string' }, job_id: { type: 'string' } } } }] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'Started background job shell_1f2e3d4c5b6a7988' }] }))
await server.connect(new StdioServerTransport())

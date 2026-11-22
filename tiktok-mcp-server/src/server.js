import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { provider, tiktokCallback } from './provider.js';
import { registerTools } from './tools.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// OAuth endpoints: /.well-known/*, /authorize, /token, /register, /revoke
app.use(mcpAuthRouter({
  provider,
  issuerUrl: new URL(config.publicUrl),
  resourceServerUrl: config.mcpUrl,
  scopesSupported: config.tiktok.scopes,
  resourceName: 'TikTok MCP',
}));

app.get('/oauth/tiktok/callback', tiktokCallback);

app.get('/', (_req, res) => res.type('text/plain').send(
  `TikTok MCP server is running.\nMCP endpoint: ${config.mcpUrl}\n`));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const auth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
});

// Stateless Streamable HTTP: a fresh MCP server per request.
app.post('/mcp', auth, async (req, res) => {
  const server = new McpServer({ name: 'tiktok-mcp', version: '1.0.0' });
  registerTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

const methodNotAllowed = (_req, res) => res.status(405).set('Allow', 'POST')
  .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', auth, methodNotAllowed);
app.delete('/mcp', auth, methodNotAllowed);

app.listen(config.port, () => {
  console.log(`TikTok MCP server listening on port ${config.port}`);
  console.log(`MCP endpoint:        ${config.mcpUrl}`);
  console.log(`TikTok redirect URI: ${config.tiktok.redirectUri}`);
});

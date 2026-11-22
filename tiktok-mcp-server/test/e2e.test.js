// End-to-end test against a mock TikTok API: OAuth flow, MCP tools, upload, refresh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const VIDEO = crypto.randomBytes(12 * 1024 * 1024); // 12 MB -> 1 chunk of 10MB + remainder merged
const received = [];
let tokenCalls = 0;
let mock, mcp, mockUrl, base;

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

const readBody = (req) => new Promise((r) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => r(Buffer.concat(chunks)));
});

before(async () => {
  mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    const okData = (data) => json({ data, error: { code: 'ok', message: '', log_id: 'l' } });
    if (url.pathname === '/v2/oauth/token/') {
      tokenCalls++;
      const p = new URLSearchParams(body.toString());
      assert.equal(p.get('client_key'), 'ck');
      if (p.get('grant_type') === 'authorization_code') assert.equal(p.get('code'), 'tiktok-code');
      return json({
        access_token: `tt-access-${tokenCalls}`, refresh_token: 'tt-refresh', open_id: 'open-123',
        // first token expires immediately so the server must refresh it
        expires_in: tokenCalls === 1 ? 1 : 86400, refresh_expires_in: 31536000,
        scope: 'user.info.basic,user.info.stats,video.list,video.publish,video.upload', token_type: 'Bearer',
      });
    }
    if (url.pathname === '/v2/user/info/') {
      assert.equal(req.headers.authorization, 'Bearer tt-access-2');
      assert.match(url.searchParams.get('fields'), /follower_count/);
      return okData({ user: { open_id: 'open-123', display_name: 'Plexxx', follower_count: 42 } });
    }
    if (url.pathname === '/v2/video/list/') return okData({ videos: [{ id: 'v1', view_count: 10 }], cursor: 1, has_more: false });
    if (url.pathname === '/v2/post/publish/video/init/') {
      const b = JSON.parse(body);
      assert.equal(b.post_info.privacy_level, 'SELF_ONLY');
      assert.equal(b.source_info.source, 'FILE_UPLOAD');
      assert.equal(b.source_info.video_size, VIDEO.length);
      assert.equal(b.source_info.total_chunk_count, 1);
      return okData({ publish_id: 'pub-1', upload_url: `${mockUrl}/upload` });
    }
    if (url.pathname === '/upload') {
      received.push({ range: req.headers['content-range'], len: body.length, body });
      res.statusCode = 201; return res.end();
    }
    if (url.pathname === '/video.mp4') { res.setHeader('Content-Length', VIDEO.length); return res.end(VIDEO); }
    if (url.pathname === '/v2/post/publish/status/fetch/') return okData({ status: 'PUBLISH_COMPLETE' });
    res.statusCode = 404; res.end();
  });
  mockUrl = `http://127.0.0.1:${await listen(mock)}`;

  const port = 3900 + Math.floor(Math.random() * 90);
  base = `http://localhost:${port}`;
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ttmcp-test-')), 'store.json');
  mcp = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(port), PUBLIC_URL: base,
      TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs',
      TOKEN_ENCRYPTION_SECRET: 'x'.repeat(40), DATA_FILE: dataFile,
      TIKTOK_AUTH_URL: `${mockUrl}/auth`, TIKTOK_API_BASE: mockUrl,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => mcp.stdout.on('data', (d) => String(d).includes('listening') && r()));
});

after(() => { mcp?.kill(); mock?.close(); });

test('full OAuth + MCP flow', async () => {
  // 401 with resource metadata pointer
  const unauth = await fetch(`${base}/mcp`, { method: 'POST' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata=/);

  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.authorization_endpoint, `${base}/authorize`);

  const redirectUri = 'http://localhost:9999/callback';
  const client = await (await fetch(meta.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'test', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  })).json();
  assert.ok(client.client_id);

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(meta.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state' })
    .forEach(([k, v]) => authUrl.searchParams.set(k, v));
  const r1 = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const toTikTok = new URL(r1.headers.get('location'));
  assert.equal(toTikTok.origin + toTikTok.pathname, `${mockUrl}/auth`);
  assert.equal(toTikTok.searchParams.get('redirect_uri'), `${base}/oauth/tiktok/callback`);

  const r2 = await fetch(`${base}/oauth/tiktok/callback?code=tiktok-code&state=${toTikTok.searchParams.get('state')}`, { redirect: 'manual' });
  const back = new URL(r2.headers.get('location'));
  assert.equal(back.searchParams.get('state'), 'client-state');
  const code = back.searchParams.get('code');
  assert.ok(code);

  const tokenRes = await fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: client.client_id, redirect_uri: redirectUri }),
  });
  const tokens = await tokenRes.json();
  assert.equal(tokenRes.status, 200, JSON.stringify(tokens));
  assert.ok(tokens.access_token && tokens.refresh_token);

  // Code is single-use
  const reuse = await fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id }),
  });
  assert.equal(reuse.status, 400);

  let id = 0;
  const rpc = async (method, params, accessToken = tokens.access_token) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text);
  };
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.ok(!r.result.isError, r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  };

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'tiktok-mcp');
  const list = await rpc('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(),
    ['get_creator_info', 'get_post_status', 'get_profile', 'get_videos', 'list_videos', 'publish_video', 'upload_video_draft']);

  const profile = await call('get_profile'); // triggers TikTok token refresh (expires_in = 1)
  assert.equal(profile.follower_count, 42);
  assert.equal(tokenCalls, 2);

  assert.equal((await call('list_videos', { max_count: 5 })).videos[0].id, 'v1');

  const pub = await call('publish_video', { video_url: `${mockUrl}/video.mp4`, privacy_level: 'SELF_ONLY', title: 'Test #fyp' });
  assert.equal(pub.publish_id, 'pub-1');
  assert.equal(received.length, 1);
  assert.equal(received[0].range, `bytes 0-${VIDEO.length - 1}/${VIDEO.length}`);
  assert.ok(received[0].body.equals(VIDEO));

  assert.equal((await call('get_post_status', { publish_id: 'pub-1' })).status, 'PUBLISH_COMPLETE');

  // Refresh token rotation
  const refreshed = await (await fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
  })).json();
  assert.ok(refreshed.access_token);
  assert.equal((await rpc('tools/list', {}, refreshed.access_token)).result.tools.length, 7);
});

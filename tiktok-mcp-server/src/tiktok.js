// Thin client for the TikTok v2 APIs (OAuth, Display API, Content Posting API).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

const { clientKey, clientSecret, apiBase } = config.tiktok;

export class TikTokError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

export function buildAuthorizeUrl(state) {
  const url = new URL(config.tiktok.authUrl);
  url.searchParams.set('client_key', clientKey);
  url.searchParams.set('scope', config.tiktok.scopes.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.tiktok.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function oauthPost(pathname, params) {
  const res = await fetch(`${apiBase}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, ...params }),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non JSON */ }
  if (!res.ok || json.error) {
    throw new TikTokError(`TikTok OAuth error: ${json.error_description || json.error || res.status}`, json);
  }
  return json;
}

const toTokenRecord = (t) => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  openId: t.open_id,
  scopes: String(t.scope || '').split(',').map((s) => s.trim()).filter(Boolean),
  expiresAt: Date.now() + Number(t.expires_in || 0) * 1000,
  refreshExpiresAt: Date.now() + Number(t.refresh_expires_in || 0) * 1000,
});

export async function exchangeCode(code) {
  return toTokenRecord(await oauthPost('/v2/oauth/token/', {
    code, grant_type: 'authorization_code', redirect_uri: config.tiktok.redirectUri,
  }));
}

export async function refreshTokens(refreshToken) {
  return toTokenRecord(await oauthPost('/v2/oauth/token/', {
    grant_type: 'refresh_token', refresh_token: refreshToken,
  }));
}

export async function revoke(accessToken) {
  await oauthPost('/v2/oauth/revoke/', { token: accessToken });
}

export async function api(accessToken, pathname, { method = 'GET', body, query } = {}) {
  const url = new URL(`${apiBase}${pathname}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const code = json?.error?.code;
  if (!res.ok || (code && code !== 'ok')) {
    throw new TikTokError(`TikTok API error (${res.status}) ${code || ''}: ${json?.error?.message || text}`.trim(), json);
  }
  return json.data;
}

// ---------- Video upload helpers ----------

const MIN_CHUNK = 5 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

export function chunkPlan(size) {
  if (size < MIN_CHUNK) return { chunkSize: size, totalChunks: 1 };
  return { chunkSize: CHUNK, totalChunks: Math.floor(size / CHUNK) };
}

/** Downloads a public video URL to a temp file and returns { file, size, cleanup }. */
export async function downloadVideo(videoUrl) {
  const url = new URL(videoUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TikTokError('video_url must be http(s).');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new TikTokError(`Could not download video (${res.status}).`);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > config.maxVideoBytes) throw new TikTokError('Video exceeds MAX_VIDEO_MB.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-mcp-'));
  const file = path.join(dir, 'video.mp4');
  let size = 0;
  const limited = Readable.fromWeb(res.body).on('data', (chunk) => {
    size += chunk.length;
    if (size > config.maxVideoBytes) limited.destroy(new TikTokError('Video exceeds MAX_VIDEO_MB.'));
  });
  try {
    await pipeline(limited, fs.createWriteStream(file));
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { file, size, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** PUTs a local file to TikTok's upload_url in chunks. */
export async function uploadFile(uploadUrl, file, size, { chunkSize, totalChunks }) {
  const fh = await fs.promises.open(file, 'r');
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = i === totalChunks - 1 ? size - 1 : start + chunkSize - 1;
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(buf.length),
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
        body: buf,
      });
      if (![200, 201, 206].includes(res.status)) {
        throw new TikTokError(`Chunk ${i + 1}/${totalChunks} upload failed (${res.status}): ${await res.text()}`);
      }
    }
  } finally {
    await fh.close();
  }
}

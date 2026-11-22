// Small persistent store (JSON file). Our own tokens are stored as SHA-256
// hashes; TikTok tokens are encrypted with AES-256-GCM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const key = crypto.createHash('sha256').update(config.encryptionSecret).digest();

export const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

const empty = () => ({
  clients: {},       // client_id -> registered MCP client
  pending: {},       // tiktok state -> pending authorization (short lived)
  codes: {},         // hash(our auth code) -> { clientId, codeChallenge, redirectUri, grantId, expiresAt }
  grants: {},        // grantId -> { clientId, openId, scopes, tiktok: encrypted tokens }
  accessTokens: {},  // hash(token) -> { grantId, clientId, expiresAt }
  refreshTokens: {}, // hash(token) -> { grantId, clientId }
});

let state = empty();
try {
  state = { ...empty(), ...JSON.parse(fs.readFileSync(config.dataFile, 'utf8')) };
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
    const tmp = `${config.dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, config.dataFile);
  }, 50);
}

export function cleanup() {
  const now = Date.now();
  for (const table of ['pending', 'codes', 'accessTokens']) {
    for (const [k, v] of Object.entries(state[table])) {
      if (v.expiresAt && v.expiresAt < now) delete state[table][k];
    }
  }
  save();
}
setInterval(cleanup, 10 * 60 * 1000).unref();

export const db = () => state;

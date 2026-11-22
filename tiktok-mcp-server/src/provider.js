// OAuth 2.1 authorization server for MCP clients (Claude, etc.), backed by TikTok Login.
//
// Flow:
//  1. MCP client registers (dynamic client registration) and calls /authorize (PKCE).
//  2. We redirect the user to TikTok Login.
//  3. TikTok redirects back to /oauth/tiktok/callback; we exchange the TikTok code,
//     store the (encrypted) TikTok tokens, and redirect to the client with OUR code.
//  4. The client exchanges our code at /token and gets OUR access/refresh tokens.
//     TikTok tokens never leave this server.
import crypto from 'node:crypto';
import { InvalidGrantError, InvalidTokenError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config } from './config.js';
import { db, save, hash, randomToken, encrypt, decrypt } from './store.js';
import * as tiktok from './tiktok.js';

const CODE_TTL_MS = 10 * 60 * 1000;

const clientsStore = {
  getClient(clientId) {
    return db().clients[clientId];
  },
  registerClient(client) {
    const full = {
      ...client,
      client_id: crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    db().clients[full.client_id] = full;
    save();
    return full;
  },
};

function issueTokens(grantId, clientId) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const s = db();
  s.accessTokens[hash(accessToken)] = {
    grantId, clientId, expiresAt: Date.now() + config.accessTokenTtlSec * 1000,
  };
  s.refreshTokens[hash(refreshToken)] = { grantId, clientId };
  save();
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: config.accessTokenTtlSec,
    refresh_token: refreshToken,
    scope: s.grants[grantId].scopes.join(' '),
  };
}

function deleteGrant(grantId) {
  const s = db();
  delete s.grants[grantId];
  for (const table of ['accessTokens', 'refreshTokens']) {
    for (const [k, v] of Object.entries(s[table])) if (v.grantId === grantId) delete s[table][k];
  }
  save();
}

export const provider = {
  clientsStore,

  async authorize(client, params, res) {
    const tiktokState = randomToken(24);
    db().pending[tiktokState] = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      expiresAt: Date.now() + CODE_TTL_MS,
    };
    save();
    res.redirect(tiktok.buildAuthorizeUrl(tiktokState));
  },

  async challengeForAuthorizationCode(client, code) {
    const entry = db().codes[hash(code)];
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return entry.codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const s = db();
    const key = hash(code);
    const entry = s.codes[key];
    delete s.codes[key]; // single use
    save();
    if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    return issueTokens(entry.grantId, client.client_id);
  },

  async exchangeRefreshToken(client, refreshToken) {
    const s = db();
    const key = hash(refreshToken);
    const entry = s.refreshTokens[key];
    if (!entry || entry.clientId !== client.client_id || !s.grants[entry.grantId]) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    delete s.refreshTokens[key]; // rotation
    return issueTokens(entry.grantId, client.client_id);
  },

  async verifyAccessToken(token) {
    const s = db();
    const entry = s.accessTokens[hash(token)];
    if (!entry || entry.expiresAt < Date.now() || !s.grants[entry.grantId]) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: s.grants[entry.grantId].scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
      extra: { grantId: entry.grantId },
    };
  },

  async revokeToken(client, { token }) {
    const s = db();
    const entry = s.accessTokens[hash(token)] || s.refreshTokens[hash(token)];
    if (!entry || entry.clientId !== client.client_id) return;
    const grant = s.grants[entry.grantId];
    if (grant) {
      try { await tiktok.revoke(decrypt(grant.tiktok).accessToken); } catch { /* best effort */ }
    }
    deleteGrant(entry.grantId);
  },
};

/** Express handler for TikTok's redirect back to us. */
export async function tiktokCallback(req, res) {
  const { code, state, error, error_description: errorDescription } = req.query;
  const s = db();
  const pending = typeof state === 'string' ? s.pending[state] : undefined;
  if (pending) delete s.pending[state];
  save();
  if (!pending || pending.expiresAt < Date.now()) {
    return res.status(400).send('Invalid or expired authorization request. Please try connecting again.');
  }

  const back = new URL(pending.redirectUri);
  if (pending.state) back.searchParams.set('state', pending.state);

  if (error || typeof code !== 'string') {
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('error_description', String(errorDescription || error || 'TikTok authorization failed'));
    return res.redirect(back.toString());
  }

  try {
    const tokens = await tiktok.exchangeCode(code);
    if (config.allowedOpenIds.length && !config.allowedOpenIds.includes(tokens.openId)) {
      try { await tiktok.revoke(tokens.accessToken); } catch { /* ignore */ }
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', 'This TikTok account is not allowed on this server.');
      console.warn(`[oauth] Rejected TikTok open_id ${tokens.openId} (not in ALLOWED_TIKTOK_OPEN_IDS)`);
      return res.redirect(back.toString());
    }
    const grantId = crypto.randomUUID();
    s.grants[grantId] = {
      clientId: pending.clientId,
      openId: tokens.openId,
      scopes: tokens.scopes,
      tiktok: encrypt(tokens),
      createdAt: Date.now(),
    };
    const ourCode = randomToken();
    s.codes[hash(ourCode)] = {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      grantId,
      expiresAt: Date.now() + CODE_TTL_MS,
    };
    save();
    console.log(`[oauth] TikTok account ${tokens.openId} connected (scopes: ${tokens.scopes.join(',')})`);
    back.searchParams.set('code', ourCode);
    return res.redirect(back.toString());
  } catch (err) {
    console.error('[oauth] TikTok code exchange failed:', err.message, err.details || '');
    back.searchParams.set('error', 'server_error');
    back.searchParams.set('error_description', 'Could not complete TikTok login.');
    return res.redirect(back.toString());
  }
}

const refreshing = new Map(); // grantId -> in-flight refresh promise

/** Returns a valid TikTok access token for a grant, refreshing it if needed. */
export async function getTikTokSession(grantId) {
  const grant = db().grants[grantId];
  if (!grant) throw new InvalidRequestError('TikTok connection not found. Please reconnect.');
  let tokens = decrypt(grant.tiktok);
  if (tokens.expiresAt - Date.now() < 5 * 60 * 1000) {
    if (!refreshing.has(grantId)) {
      refreshing.set(grantId, tiktok.refreshTokens(tokens.refreshToken)
        .then((fresh) => {
          grant.tiktok = encrypt(fresh);
          if (fresh.scopes.length) grant.scopes = fresh.scopes;
          save();
          return fresh;
        })
        .finally(() => refreshing.delete(grantId)));
    }
    tokens = await refreshing.get(grantId);
  }
  return { accessToken: tokens.accessToken, openId: tokens.openId, scopes: grant.scopes };
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.PORT || 3000);
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  publicUrl,
  mcpUrl: new URL(`${publicUrl}/mcp`),
  tiktok: {
    clientKey: required('TIKTOK_CLIENT_KEY'),
    clientSecret: required('TIKTOK_CLIENT_SECRET'),
    scopes: (process.env.TIKTOK_SCOPES ||
      'user.info.basic,user.info.profile,user.info.stats,video.list,video.publish,video.upload')
      .split(',').map((s) => s.trim()).filter(Boolean),
    redirectUri: `${publicUrl}/oauth/tiktok/callback`,
    // Overridable for tests only.
    authUrl: process.env.TIKTOK_AUTH_URL || 'https://www.tiktok.com/v2/auth/authorize/',
    apiBase: (process.env.TIKTOK_API_BASE || 'https://open.tiktokapis.com').replace(/\/+$/, ''),
  },
  // Secret used to encrypt TikTok tokens at rest (any long random string).
  encryptionSecret: required('TOKEN_ENCRYPTION_SECRET'),
  dataFile: process.env.DATA_FILE || './data/store.json',
  // Optional allow-list of TikTok open_ids allowed to connect (comma separated).
  allowedOpenIds: (process.env.ALLOWED_TIKTOK_OPEN_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC || 3600),
  maxVideoBytes: Number(process.env.MAX_VIDEO_MB || 1024) * 1024 * 1024,
};

if (config.encryptionSecret.length < 32) {
  console.error('[config] TOKEN_ENCRYPTION_SECRET must be at least 32 characters.');
  process.exit(1);
}

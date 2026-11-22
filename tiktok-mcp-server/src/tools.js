// MCP tools exposed to the AI client. Each call uses the TikTok account linked
// to the caller's OAuth token.
import { z } from 'zod';
import * as tiktok from './tiktok.js';
import { getTikTokSession } from './provider.js';

const VIDEO_FIELDS = 'id,title,video_description,create_time,duration,cover_image_url,share_url,embed_link,view_count,like_count,comment_count,share_count';

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `${err.message}${err.details ? `\n${JSON.stringify(err.details)}` : ''}` }],
});

function requireScope(session, scope) {
  if (!session.scopes.includes(scope)) {
    throw new Error(`The connected TikTok account did not grant the "${scope}" scope. ` +
      'Enable it for your TikTok app, add it to TIKTOK_SCOPES and reconnect.');
  }
}

/** Wraps a handler: resolves the TikTok session from the MCP auth info and formats errors. */
const withSession = (fn) => async (args, extra) => {
  try {
    const grantId = extra?.authInfo?.extra?.grantId;
    if (!grantId) throw new Error('Not authenticated.');
    return ok(await fn(await getTikTokSession(grantId), args));
  } catch (err) {
    return fail(err);
  }
};

const postInfoShape = {
  title: z.string().max(2200).optional()
    .describe('Caption of the post, may include #hashtags and @mentions (max 2200 chars).'),
  privacy_level: z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'])
    .describe('Must be one of privacy_level_options returned by get_creator_info. Unaudited apps can only use SELF_ONLY.'),
  disable_comment: z.boolean().default(false),
  disable_duet: z.boolean().default(false),
  disable_stitch: z.boolean().default(false),
  video_cover_timestamp_ms: z.number().int().min(0).optional()
    .describe('Timestamp (ms) of the frame used as cover.'),
  brand_content_toggle: z.boolean().default(false)
    .describe('true if the video is a paid partnership promoting a third-party brand.'),
  brand_organic_toggle: z.boolean().default(false)
    .describe("true if the video promotes the creator's own business."),
  is_aigc: z.boolean().default(false).describe('true if the video is AI-generated content.'),
};

async function initUpload(session, endpoint, videoUrl, uploadMethod, body) {
  if (uploadMethod === 'pull_from_url') {
    const data = await tiktok.api(session.accessToken, endpoint, {
      method: 'POST',
      body: { ...body, source_info: { source: 'PULL_FROM_URL', video_url: videoUrl } },
    });
    return { publish_id: data.publish_id, upload_method: 'pull_from_url' };
  }
  const video = await tiktok.downloadVideo(videoUrl);
  try {
    const plan = tiktok.chunkPlan(video.size);
    const data = await tiktok.api(session.accessToken, endpoint, {
      method: 'POST',
      body: {
        ...body,
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: video.size,
          chunk_size: plan.chunkSize,
          total_chunk_count: plan.totalChunks,
        },
      },
    });
    await tiktok.uploadFile(data.upload_url, video.file, video.size, plan);
    return { publish_id: data.publish_id, upload_method: 'file_upload', bytes: video.size };
  } finally {
    video.cleanup();
  }
}

const uploadShape = {
  video_url: z.string().url().describe('Public URL of an MP4/MOV/WebM video file.'),
  upload_method: z.enum(['file_upload', 'pull_from_url']).default('file_upload')
    .describe('file_upload: this server downloads the video and uploads it to TikTok (works with any URL). ' +
      'pull_from_url: TikTok fetches the URL itself (the domain must be verified in your TikTok app).'),
};

export function registerTools(server) {
  server.registerTool('get_profile', {
    title: 'Get TikTok profile',
    description: 'Get the connected TikTok account profile and statistics (followers, likes, video count).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, withSession(async (session) => {
    const fields = ['open_id', 'union_id', 'avatar_url', 'display_name'];
    if (session.scopes.includes('user.info.profile')) fields.push('bio_description', 'profile_deep_link', 'is_verified', 'username');
    if (session.scopes.includes('user.info.stats')) fields.push('follower_count', 'following_count', 'likes_count', 'video_count');
    const data = await tiktok.api(session.accessToken, '/v2/user/info/', { query: { fields: fields.join(',') } });
    return data.user;
  }));

  server.registerTool('list_videos', {
    title: 'List TikTok videos',
    description: "List the connected account's public videos, newest first, with views/likes/comments/shares. " +
      'Use the returned cursor to get the next page.',
    inputSchema: {
      max_count: z.number().int().min(1).max(20).default(10),
      cursor: z.number().int().optional().describe('Cursor from a previous call (has_more = true).'),
    },
    annotations: { readOnlyHint: true },
  }, withSession(async (session, { max_count, cursor }) => {
    requireScope(session, 'video.list');
    return tiktok.api(session.accessToken, '/v2/video/list/', {
      method: 'POST', query: { fields: VIDEO_FIELDS }, body: { max_count, ...(cursor ? { cursor } : {}) },
    });
  }));

  server.registerTool('get_videos', {
    title: 'Get TikTok videos by id',
    description: 'Get details and up-to-date stats for specific videos of the connected account.',
    inputSchema: { video_ids: z.array(z.string()).min(1).max(20) },
    annotations: { readOnlyHint: true },
  }, withSession(async (session, { video_ids }) => {
    requireScope(session, 'video.list');
    return tiktok.api(session.accessToken, '/v2/video/query/', {
      method: 'POST', query: { fields: VIDEO_FIELDS }, body: { filters: { video_ids } },
    });
  }));

  server.registerTool('get_creator_info', {
    title: 'Get posting options',
    description: 'Get the creator info required before publishing: nickname, allowed privacy levels, ' +
      'whether comments/duets/stitches are disabled, and max video duration. ' +
      'ALWAYS call this before publish_video and show the options to the user.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, withSession(async (session) => {
    requireScope(session, 'video.publish');
    return tiktok.api(session.accessToken, '/v2/post/publish/creator_info/query/', { method: 'POST', body: {} });
  }));

  server.registerTool('publish_video', {
    title: 'Publish a video to TikTok',
    description: 'Publish a video directly to the connected TikTok account (Direct Post). ' +
      'Before calling: call get_creator_info, then have the user explicitly confirm the caption, ' +
      'the privacy level (no default) and the interaction settings. ' +
      'Returns a publish_id; use get_post_status to follow processing.',
    inputSchema: { ...uploadShape, ...postInfoShape },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, withSession(async (session, { video_url, upload_method, ...postInfo }) => {
    requireScope(session, 'video.publish');
    return initUpload(session, '/v2/post/publish/video/init/', video_url, upload_method, { post_info: postInfo });
  }));

  server.registerTool('upload_video_draft', {
    title: 'Send a video to TikTok inbox (draft)',
    description: "Upload a video to the user's TikTok inbox as a draft. The user then finishes editing " +
      'and posts it from the TikTok app (they receive a notification).',
    inputSchema: uploadShape,
    annotations: { destructiveHint: false, openWorldHint: true },
  }, withSession(async (session, { video_url, upload_method }) => {
    requireScope(session, 'video.upload');
    return initUpload(session, '/v2/post/publish/inbox/video/init/', video_url, upload_method, {});
  }));

  server.registerTool('get_post_status', {
    title: 'Get publishing status',
    description: 'Check the status of a publish_id (PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, ' +
      'SEND_TO_USER_INBOX, PUBLISH_COMPLETE or FAILED with fail_reason).',
    inputSchema: { publish_id: z.string() },
    annotations: { readOnlyHint: true },
  }, withSession(async (session, { publish_id }) => tiktok.api(session.accessToken,
    '/v2/post/publish/status/fetch/', { method: 'POST', body: { publish_id } })));
}

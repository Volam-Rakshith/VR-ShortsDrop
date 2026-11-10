/*
 * YouTube upload core for VR ShortsDrop (v2, by VR Developments).
 * - refreshes an access token from the channel's refresh token (Google OAuth)
 * - resumable upload (uploadType=resumable), sent in chunks so a dropped chunk
 *   can be asked about and continued instead of starting over
 * - a queue that runs one upload at a time and stops the whole queue on quota
 * The network is an injected `transport` so tests can run the same code against a mock.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipUploader = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
  // Resumable chunks must be a multiple of 256 KiB (except the last one). 8 MiB here.
  const DEFAULT_CHUNK = 256 * 1024 * 32;
  const MAX_CHUNK_RETRIES = 5;
  const QUOTA_REASONS = /quotaExceeded|uploadLimitExceeded|dailyLimitExceeded/i;
  const SHORT_MAX_SECONDS = 60;
  const DEFAULT_CATEGORY_ID = '22'; // People & Blogs. Fixed in v1.

  class UploadError extends Error {
    constructor(kind, message, detail) {
      super(message);
      this.name = 'UploadError';
      this.kind = kind;     // 'quota' | 'auth' | 'failed'
      this.detail = detail || null;
    }
  }

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function classify(res) {
    let reason = '';
    try {
      const body = JSON.parse(res.text || '{}');
      reason = (body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason) || (body.error && body.error.status) || '';
    } catch (_) { /* not JSON */ }
    if (res.status === 403 && QUOTA_REASONS.test(reason)) return new UploadError('quota', 'daily quota reached, resume tomorrow', { status: res.status, reason });
    if (res.status === 401) return new UploadError('auth', 'YouTube refused the channel login (check the client id, secret and refresh token)', { status: res.status, reason });
    return new UploadError('failed', `YouTube answered ${res.status}${reason ? ' (' + reason + ')' : ''}`, { status: res.status, reason });
  }

  function nextOffsetFrom(res, fallback) {
    // A 308 says which bytes Google holds: "Range: bytes=0-N" means N+1 bytes are in.
    const range = res.headers && (res.headers['range'] || res.headers['Range']);
    if (!range) return fallback;
    const m = /bytes=0-(\d+)/.exec(range);
    return m ? parseInt(m[1], 10) + 1 : fallback;
  }

  function sizeOf(source) {
    return typeof source.size === 'number' ? source.size : source.byteLength;
  }

  function sliceOf(source, start, end) {
    return source instanceof Uint8Array ? source.subarray(start, end) : source.slice(start, end);
  }

  async function getAccessToken(channel, transport) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: channel.clientId,
      client_secret: channel.clientSecret,
      refresh_token: channel.refreshToken,
    }).toString();
    const res = await transport.request({
      method: 'POST',
      url: TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (res.status !== 200) {
      // 400 invalid_grant / 401 means the refresh token or client details are wrong: a setup problem, not a quota.
      throw new UploadError('auth', 'YouTube refused the channel login (check the client id, secret and refresh token)', { status: res.status });
    }
    const json = JSON.parse(res.text);
    if (!json.access_token) throw new UploadError('auth', 'no access token came back from the login step');
    return json.access_token;
  }

  // fields: { title, description, tags, privacyStatus, isShort }
  function buildResource(fields) {
    let title = String(fields.title || '').replace(/\s+/g, ' ').trim();
    if (fields.isShort && !/#shorts\b/i.test(title)) {
      const suffix = ' #Shorts';
      const room = 100 - suffix.length;
      title = Array.from(title).slice(0, room).join('').trim() + suffix;
    }
    const resource = {
      snippet: {
        title,
        description: String(fields.description || ''),
        tags: Array.isArray(fields.tags) ? fields.tags : [],
        categoryId: DEFAULT_CATEGORY_ID,
      },
      status: {
        privacyStatus: fields.privacyStatus || 'private',
        selfDeclaredMadeForKids: false,
      },
    };
    return resource;
  }

  function mimeFor(name, fallback) {
    if (fallback) return fallback;
    return /\.mov$/i.test(name || '') ? 'video/quicktime' : 'video/mp4';
  }

  async function uploadVideo(opts) {
    const { transport, accessToken, source, name, resource, chunkSize = DEFAULT_CHUNK, sleep = defaultSleep, onProgress = () => {} } = opts;
    const size = sizeOf(source);
    if (!size) throw new UploadError('failed', 'the file is empty');
    const mime = mimeFor(name, opts.mime);

    const init = await transport.request({
      method: 'POST',
      url: UPLOAD_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': mime,
      },
      body: JSON.stringify(resource),
    });
    if (init.status !== 200) throw classify(init);
    const sessionUrl = init.headers['location'] || init.headers['Location'];
    if (!sessionUrl) throw new UploadError('failed', 'YouTube did not open an upload session');

    let offset = 0;
    let retries = 0;
    while (offset < size) {
      const end = Math.min(offset + chunkSize, size);
      const res = await transport.request({
        method: 'PUT',
        url: sessionUrl,
        headers: {
          'Content-Type': mime,
          'Content-Range': `bytes ${offset}-${end - 1}/${size}`,
        },
        body: sliceOf(source, offset, end),
        onUploadProgress: (sentInChunk) => onProgress((offset + sentInChunk) / size),
      });

      if (res.status === 200 || res.status === 201) {
        onProgress(1);
        return JSON.parse(res.text);
      }
      if (res.status === 308) {
        offset = nextOffsetFrom(res, offset);
        retries = 0;
        continue;
      }
      if (res.status >= 500 && retries < MAX_CHUNK_RETRIES) {
        // Ask Google how many bytes it kept, then continue from there.
        retries += 1;
        await sleep(Math.min(2 ** retries * 250, 8000));
        const probe = await transport.request({
          method: 'PUT',
          url: sessionUrl,
          headers: { 'Content-Range': `bytes */${size}` },
        });
        if (probe.status === 200 || probe.status === 201) {
          onProgress(1);
          return JSON.parse(probe.text);
        }
        if (probe.status === 308) offset = nextOffsetFrom(probe, 0);
        continue;
      }
      throw classify(res);
    }
    throw new UploadError('failed', 'upload ended without a confirmation from YouTube');
  }

  /*
   * items: [{ id, name, size, source, mime, fields, include }]
   * Runs included items one at a time. Stops the whole queue on a quota answer.
   * onEvent receives { type, id, ... } for the page to draw.
   */
  async function runQueue(items, opts) {
    const { transport, channel, onEvent = () => {}, chunkSize, sleep } = opts;
    const summary = { done: 0, failed: 0, stoppedForQuota: false, skipped: 0 };
    const queue = items.filter((it) => it.include !== false);
    summary.skipped = items.length - queue.length;
    items.filter((it) => it.include === false).forEach((it) => onEvent({ type: 'skipped', id: it.id }));

    let token = await getAccessToken(channel, transport);
    for (const item of queue) {
      if (opts.isCancelled && opts.isCancelled()) break;
      const resource = buildResource(item.fields);
      onEvent({ type: 'start', id: item.id, resource });
      const attempt = async () => uploadVideo({
        transport, accessToken: token, source: item.source, name: item.name, mime: item.mime,
        resource, chunkSize, sleep,
        onProgress: (fraction) => onEvent({ type: 'progress', id: item.id, fraction }),
      });
      try {
        let result;
        try {
          result = await attempt();
        } catch (err) {
          if (err instanceof UploadError && err.kind === 'auth') {
            token = await getAccessToken(channel, transport); // one fresh token, one retry
            result = await attempt();
          } else {
            throw err;
          }
        }
        summary.done += 1;
        onEvent({ type: 'done', id: item.id, videoId: result.id, url: `https://www.youtube.com/watch?v=${result.id}` });
      } catch (err) {
        if (err instanceof UploadError && err.kind === 'quota') {
          summary.stoppedForQuota = true;
          onEvent({ type: 'quota', id: item.id, message: 'daily quota reached, resume tomorrow' });
          // Everything still waiting goes back to waiting; nothing else is attempted today.
          queue.slice(queue.indexOf(item) + 1).forEach((rest) => onEvent({ type: 'waiting', id: rest.id }));
          break;
        }
        summary.failed += 1;
        onEvent({ type: 'failed', id: item.id, message: err.message });
      }
    }
    onEvent({ type: 'finished', summary });
    return summary;
  }

  function makeXhrTransport(XHR) {
    const Ctor = XHR || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null);
    return {
      request(req) {
        return new Promise((resolve, reject) => {
          const xhr = new Ctor();
          xhr.open(req.method, req.url, true);
          Object.entries(req.headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
          if (req.onUploadProgress && xhr.upload) {
            xhr.upload.onprogress = (e) => { if (e.lengthComputable) req.onUploadProgress(e.loaded); };
          }
          xhr.onload = () => {
            const headers = {};
            (xhr.getAllResponseHeaders() || '').split(/\r?\n/).forEach((line) => {
              const i = line.indexOf(':');
              if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            });
            resolve({ status: xhr.status, headers, text: xhr.responseText || '' });
          };
          xhr.onerror = () => reject(new UploadError('failed', 'the connection dropped; the upload can be retried'));
          xhr.send(req.body === undefined ? null : req.body);
        });
      },
    };
  }

  return {
    UPLOAD_URL, TOKEN_URL, DEFAULT_CHUNK, SHORT_MAX_SECONDS,
    UploadError, buildResource, getAccessToken, uploadVideo, runQueue, makeXhrTransport,
  };
});

const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/uploader.js');
const S = require('../src/storage.js');

const CHANNEL = { channelName: 'VR Test', clientId: 'test-client.apps.example', clientSecret: 'test-secret', refreshToken: 'test-refresh' };
const KIB = 1024;

// A mock of the YouTube endpoints: token refresh, resumable session, chunk PUTs,
// and the status probe. Behaviour is set per test through `plan`.
function mockYouTube(plan = {}) {
  const log = [];
  const sessions = new Map();
  let sessionCount = 0;
  let chunkCalls = 0;
  const transport = {
    log,
    async request(req) {
      log.push({ method: req.method, url: req.url, range: req.headers && req.headers['Content-Range'] });
      if (req.url === U.TOKEN_URL) {
        if (plan.badToken) return { status: 400, headers: {}, text: JSON.stringify({ error: 'invalid_grant' }) };
        return { status: 200, headers: {}, text: JSON.stringify({ access_token: 'tok-' + (log.filter((l) => l.url === U.TOKEN_URL).length) }) };
      }
      if (req.url === U.UPLOAD_URL) {
        if (plan.quotaOnSession && sessionCount >= plan.quotaOnSession) {
          return { status: 403, headers: {}, text: JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }], code: 403 } }) };
        }
        sessionCount += 1;
        const id = 'sess' + sessionCount;
        const meta = JSON.parse(req.body);
        sessions.set(id, { received: 0, total: Number(req.headers['X-Upload-Content-Length']), title: meta.snippet.title, privacy: meta.status.privacyStatus, tags: meta.snippet.tags, description: meta.snippet.description });
        return { status: 200, headers: { location: `https://upload.example/session/${id}` }, text: '' };
      }
      const id = req.url.split('/').pop();
      const s = sessions.get(id);
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['Content-Range'] || '');
      if (!s) return { status: 404, headers: {}, text: '' };
      if (m === null) {
        // status probe: "bytes */total"
        if (s.received === 0) return { status: 308, headers: {}, text: '' };
        return { status: 308, headers: { range: `bytes=0-${s.received - 1}` }, text: '' };
      }
      chunkCalls += 1;
      // report bytes as they go out, the way the browser transport does: half the chunk first, then the rest
      if (req.onUploadProgress) req.onUploadProgress(Math.floor(req.body.byteLength / 2));
      if (plan.failChunkNumber && chunkCalls === plan.failChunkNumber) {
        return { status: 503, headers: {}, text: 'unavailable' };
      }
      const start = Number(m[1]);
      const end = Number(m[2]);
      const total = Number(m[3]);
      const bytes = req.body.byteLength;
      if (start !== s.received) return { status: 400, headers: {}, text: 'out of order' };
      s.received = end + 1;
      if (s.received === total) {
        s.total = total;
        return { status: 200, headers: {}, text: JSON.stringify({ id: 'vid' + id, kind: 'youtube#video' }) };
      }
      return { status: 308, headers: { range: `bytes=0-${end}` }, text: '' };
    },
    sessions,
  };
  return transport;
}

function fakeVideo(bytes) {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = i % 251;
  return data;
}

test('resource: Shorts get #Shorts once, titles stay at 100 characters, privacy defaults to private', () => {
  const long = 'x'.repeat(120);
  const r = U.buildResource({ title: long, description: 'd', tags: ['a'], isShort: true });
  assert.ok(r.snippet.title.endsWith(' #Shorts'));
  assert.equal(Array.from(r.snippet.title).length, 100);
  assert.equal(U.buildResource({ title: 'hi #shorts', isShort: true }).snippet.title, 'hi #shorts');
  assert.equal(U.buildResource({ title: 'plain', isShort: false }).snippet.title, 'plain');
  assert.equal(r.status.privacyStatus, 'private');
  assert.equal(r.status.selfDeclaredMadeForKids, false);
});

test('dry run: two videos upload one at a time, chunked, with progress and links; token from refresh', async () => {
  const t = mockYouTube();
  const events = [];
  const items = [
    { id: 'a', name: 'one.mp4', source: fakeVideo(600 * KIB), fields: { title: 'One #Shorts', description: 'first', tags: ['x'], isShort: true, privacyStatus: 'private' } },
    { id: 'b', name: 'two.mov', source: fakeVideo(300 * KIB), fields: { title: 'Two', description: 'second', tags: [], isShort: false, privacyStatus: 'unlisted' } },
  ];
  const summary = await U.runQueue(items, { transport: t, channel: CHANNEL, chunkSize: 256 * KIB, sleep: async () => {}, onEvent: (e) => events.push(e) });

  assert.deepEqual(summary, { done: 2, failed: 0, stoppedForQuota: false, skipped: 0 });
  // 600 KiB at 256 KiB chunks = 3 PUTs; 300 KiB = 2 PUTs
  const puts = t.log.filter((l) => l.method === 'PUT');
  assert.equal(puts.length, 5);
  assert.equal(puts[0].range, `bytes 0-${256 * KIB - 1}/${600 * KIB}`);
  // one token refresh for the whole run
  assert.equal(t.log.filter((l) => l.url === U.TOKEN_URL).length, 1);
  // metadata reached the session
  const sessions = [...t.sessions.values()];
  assert.equal(sessions[0].title.endsWith(' #Shorts'), true);
  assert.equal(sessions[0].privacy, 'private');
  assert.equal(sessions[1].privacy, 'unlisted');
  // progress reported and done links produced
  assert.ok(events.some((e) => e.type === 'progress' && e.id === 'a' && e.fraction > 0 && e.fraction < 1));
  const doneA = events.find((e) => e.type === 'done' && e.id === 'a');
  assert.equal(doneA.url, 'https://www.youtube.com/watch?v=' + doneA.videoId);
  // order: a finished before b started
  const order = events.filter((e) => e.type === 'start').map((e) => e.id);
  assert.deepEqual(order, ['a', 'b']);
});

test('a dropped chunk (503) is asked about and continued, not restarted', async () => {
  const t = mockYouTube({ failChunkNumber: 2 });
  const items = [{ id: 'a', name: 'v.mp4', source: fakeVideo(600 * KIB), fields: { title: 'T', description: '', tags: [], isShort: false } }];
  const summary = await U.runQueue(items, { transport: t, channel: CHANNEL, chunkSize: 256 * KIB, sleep: async () => {} });
  assert.equal(summary.done, 1);
  const puts = t.log.filter((l) => l.method === 'PUT' && /bytes \d+-/.test(l.range || ''));
  // chunks 1, 2 (failed), 2 again after the probe, 3
  assert.equal(puts.length, 4);
  assert.equal(puts[2].range, puts[1].range);
});

test('quota: queue stops, shows the message, leaves the rest waiting and does not start them', async () => {
  const t = mockYouTube({ quotaOnSession: 1 });
  const events = [];
  const items = [
    { id: 'a', name: 'a.mp4', source: fakeVideo(10 * KIB), fields: { title: 'A', description: '', tags: [], isShort: false } },
    { id: 'b', name: 'b.mp4', source: fakeVideo(10 * KIB), fields: { title: 'B', description: '', tags: [], isShort: false } },
    { id: 'c', name: 'c.mp4', source: fakeVideo(10 * KIB), fields: { title: 'C', description: '', tags: [], isShort: false } },
  ];
  const summary = await U.runQueue(items, { transport: t, channel: CHANNEL, sleep: async () => {}, onEvent: (e) => events.push(e) });
  assert.equal(summary.done, 1);
  assert.equal(summary.stoppedForQuota, true);
  const quota = events.find((e) => e.type === 'quota');
  assert.equal(quota.id, 'b');
  assert.equal(quota.message, 'daily quota reached, resume tomorrow');
  assert.ok(events.some((e) => e.type === 'waiting' && e.id === 'c'));
  assert.ok(!events.some((e) => e.type === 'start' && e.id === 'c'));
});

test('skipped items (not a Short, unticked) are never uploaded', async () => {
  const t = mockYouTube();
  const items = [
    { id: 'a', name: 'a.mp4', source: fakeVideo(4 * KIB), include: false, fields: { title: 'A', description: '', tags: [], isShort: false } },
    { id: 'b', name: 'b.mp4', source: fakeVideo(4 * KIB), fields: { title: 'B', description: '', tags: [], isShort: true } },
  ];
  const summary = await U.runQueue(items, { transport: t, channel: CHANNEL, sleep: async () => {} });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.done, 1);
});

test('bad refresh token is an auth error that names the channel setup, no upload starts', async () => {
  const t = mockYouTube({ badToken: true });
  await assert.rejects(
    U.runQueue([{ id: 'a', name: 'a.mp4', source: fakeVideo(4 * KIB), fields: { title: 'A' } }], { transport: t, channel: CHANNEL }),
    (err) => err.kind === 'auth' && /refresh token/.test(err.message)
  );
  assert.equal(t.log.filter((l) => l.url === U.UPLOAD_URL).length, 0);
});

test('storage: channel details save, load back trimmed, and clear', () => {
  const mem = new Map();
  const store = S.createStore({ getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) });
  store.save({ ...CHANNEL, clientSecret: '  s  ' });
  assert.equal(store.load().clientSecret, 's');
  assert.equal(S.isComplete(store.load()), true);
  assert.equal(S.isComplete(S.clean({})), false);
  store.clear();
  assert.equal(store.load().clientId, '');
});

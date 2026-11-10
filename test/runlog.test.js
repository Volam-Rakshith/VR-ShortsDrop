const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/runlog.js');
const U = require('../src/uploader.js');

const FIELDS_A = { title: 'Morning drill', description: 'line one\nline two', tags: ['vr', 'shorts'], privacyStatus: 'private', instagramCaption: 'ig caption A', youtubeCaptions: 'yt captions A' };

function pageVideos() {
  return [
    { id: 'a', name: 'a.mp4', size: 10, isShort: true, include: true, status: 'waiting', fields: FIELDS_A },
    { id: 'b', name: 'b.mov', size: 10, isShort: false, include: false, status: 'waiting', fields: { title: 'Wide one', description: '', tags: [], privacyStatus: 'private' } },
    { id: 'c', name: 'c.mp4', size: 10, isShort: true, include: true, status: 'waiting', fields: { title: 'Third', description: 'd3', tags: [], privacyStatus: 'private' } },
    { id: 'd', name: 'd.mp4', size: 10, isShort: true, include: true, status: 'waiting', fields: null },
  ];
}

// the same mock YouTube endpoints the upload tests use: second session answers quotaExceeded
function mockTransport(quotaOnSession) {
  let sessions = 0;
  return {
    async request(req) {
      if (req.url.startsWith(U.TOKEN_URL)) return { status: 200, headers: {}, text: JSON.stringify({ access_token: 'tok' }) };
      if (req.url.startsWith(U.UPLOAD_URL)) {
        sessions += 1;
        if (sessions === quotaOnSession) return { status: 403, headers: {}, text: JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }) };
        return { status: 200, headers: { location: 'https://upload.example/s' + sessions }, text: '' };
      }
      if (req.url.startsWith('https://upload.example/')) {
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['Content-Range']);
        if (+m[2] + 1 >= +m[3]) return { status: 200, headers: {}, text: JSON.stringify({ id: 'vid' + sessions }) };
        return { status: 308, headers: { range: `bytes=0-${m[2]}` }, text: '' };
      }
      return { status: 404, headers: {}, text: '' };
    },
  };
}

// the page's own wiring, reduced: the same calls app.js makes for each queue event
async function runAndLog(videos, transport, cancelRef) {
  const run = L.newRun('2026-11-09T17:00:00.000Z', videos);
  const items = videos.filter((v) => v.include && v.fields).map((v) => ({ id: v.id, name: v.name, size: 10, source: new Uint8Array(10), fields: { ...v.fields, isShort: v.isShort } }));
  const summary = await U.runQueue(items, {
    transport,
    channel: { clientId: 'x', clientSecret: 'SECRET-VALUE', refreshToken: 'REFRESH-VALUE' },
    chunkSize: 1000,
    isCancelled: () => (cancelRef ? cancelRef.stop : false),
    onEvent: (e) => {
      if (e.type === 'start') L.markStarted(run, e.id, e.resource);
      if (e.type === 'done') L.markUploaded(run, e.id, e.url);
      if (e.type === 'failed') L.markFailed(run, e.id, e.message);
      if (e.type === 'quota') L.markNotUploaded(run, e.id, L.REASON_QUOTA);
    },
  });
  L.finishRun(run, { stoppedForQuota: summary.stoppedForQuota, cancelled: !!(cancelRef && cancelRef.stop) });
  return { run, summary };
}

test('log: a run starts with one entry per video and the reason each video is not uploaded', () => {
  const run = L.newRun('2026-11-09T17:00:00.000Z', pageVideos());
  assert.equal(run.entries.length, 4);
  assert.equal(run.entries[1].reason, L.REASON_NOT_TICKED);
  assert.match(run.entries[3].reason, /no text block/);
  assert.equal(run.entries[0].status, 'not uploaded');
  assert.ok(L.STATUSES.includes('uploaded') && L.STATUSES.includes('failed') && L.STATUSES.includes('not uploaded'));
});

test('log: the title, description and tags recorded are the ones YouTube was sent (a Short gets #Shorts)', async () => {
  const { run } = await runAndLog(pageVideos(), mockTransport(0));
  const a = run.entries[0];
  assert.equal(a.status, 'uploaded');
  assert.equal(a.title, 'Morning drill #Shorts', 'the title as sent, with the Shorts tag');
  assert.equal(a.description, 'line one\nline two');
  assert.deepEqual(a.tags, ['vr', 'shorts']);
  assert.equal(a.privacy, 'private');
  assert.equal(a.link, 'https://www.youtube.com/watch?v=vid1');
  assert.equal(a.instagramCaption, 'ig caption A', 'the caption copy is kept beside it');
});

test('log: a quota answer stops the queue; the video that hit it and the rest are logged as not uploaded with the reason', async () => {
  const { run, summary } = await runAndLog(pageVideos(), mockTransport(2));
  assert.equal(summary.stoppedForQuota, true);
  assert.equal(run.entries[0].status, 'uploaded');
  assert.equal(run.entries[2].status, 'not uploaded');
  assert.equal(run.entries[2].reason, L.REASON_QUOTA);
  assert.equal(run.entries[1].reason, L.REASON_NOT_TICKED);
  const s = L.summarize(run);
  assert.deepEqual([s.uploaded, s.failed, s.notUploaded], [1, 0, 3]);
});

test('log: a failed upload is logged as failed with its message', () => {
  const run = L.newRun('2026-11-09T17:00:00.000Z', pageVideos());
  L.markFailed(run, 'a', 'YouTube answered 500');
  assert.equal(run.entries[0].status, 'failed');
  assert.equal(run.entries[0].reason, 'YouTube answered 500');
});

test('log: the text file lists every video with its status, title, description, tags and the reason', async () => {
  const { run } = await runAndLog(pageVideos(), mockTransport(2));
  const text = L.toText(run);
  assert.match(text, /^VR ShortsDrop upload log \(by VR Developments\)/);
  assert.match(text, /01 · a\.mp4 · UPLOADED · Short/);
  assert.match(text, /title used: Morning drill #Shorts/);
  assert.match(text, /tags used: vr, shorts/);
  assert.match(text, /02 · b\.mov · NOT UPLOADED/);
  assert.match(text, /reason: not ticked for upload/);
  assert.match(text, /03 · c\.mp4 · NOT UPLOADED/);
  assert.match(text, /reason: daily quota reached, resume tomorrow/);
  assert.match(text, /uploaded: 1 · failed: 0 · not uploaded: 3/);
  // the file never carries the channel's secrets
  assert.doesNotMatch(text, /SECRET-VALUE|REFRESH-VALUE/);
});

test('log: a cancelled run says the queue was stopped by the person', () => {
  const run = L.newRun('2026-11-09T17:00:00.000Z', pageVideos());
  L.finishRun(run, { cancelled: true });
  assert.equal(run.entries[0].reason, L.REASON_CANCELLED);
  assert.ok(run.endedAt);
});

test('log: runs are kept in browser storage, newest last, a rerun of the same run replaces it, the last 20 are kept', () => {
  const data = new Map();
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
  const run = L.newRun('2026-11-09T17:00:00.000Z', pageVideos());
  L.saveRun(storage, run);
  L.markUploaded(run, 'a', 'https://www.youtube.com/watch?v=x');
  L.saveRun(storage, run);
  assert.equal(L.loadRuns(storage).length, 1);
  assert.equal(L.loadRuns(storage)[0].entries[0].status, 'uploaded');
  for (let i = 1; i <= 25; i++) L.saveRun(storage, L.newRun(`2026-11-0${(i % 9) + 1}T10:00:${String(i).padStart(2, '0')}.000Z`, pageVideos()));
  assert.equal(L.loadRuns(storage).length, L.KEEP);
  L.clearRuns(storage);
  assert.deepEqual(L.loadRuns(storage), []);
});

test('log: file name is safe and dated', () => {
  const run = L.newRun('2026-11-09T17:00:00.000Z', []);
  assert.match(L.fileNameFor(run), /^shortsdrop-log-\d+\.txt$/);
});

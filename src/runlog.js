/*
 * Per-run upload log for VR ShortsDrop (stage 7).
 * One run = one press of "Start upload queue". Every video in the page gets an entry with the
 * title, description, tags and captions actually used, and a status: uploaded, failed, or
 * not uploaded (with the reason). Runs are kept in this browser's localStorage (last 20) and
 * can be downloaded as a plain text file. Channel secrets are never written to the log.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipRunLog = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const KEY = 'shortsdrop.runs.v1';
  const KEEP = 20;
  const STATUSES = ['uploaded', 'failed', 'not uploaded'];
  const REASON_NOT_TICKED = 'not ticked for upload in step 04';
  const REASON_NO_TEXT = 'no text block for this video in step 03';
  const REASON_NOT_REACHED = 'the queue had not reached this video yet';
  const REASON_QUOTA = 'daily quota reached, resume tomorrow';
  const REASON_CANCELLED = 'queue stopped by you before this video';
  const REASON_ALREADY = 'already uploaded in an earlier run, not sent again';

  function captionsOf(fields) {
    return {
      instagramCaption: (fields && fields.instagramCaption) || '',
      youtubeCaptions: (fields && fields.youtubeCaptions) || '',
    };
  }

  // videos: [{ id, name, size, isShort, include, fields, status }] as the page holds them when the run starts.
  function newRun(startedAt, videos) {
    const entries = videos.map((v, i) => {
      const f = v.fields || {};
      let reason = '';
      if (v.status === 'done') reason = REASON_ALREADY;
      else if (!v.include) reason = REASON_NOT_TICKED;
      else if (!v.fields) reason = REASON_NO_TEXT;
      else reason = REASON_NOT_REACHED;
      return {
        n: i + 1,
        id: v.id,
        file: v.name,
        isShort: !!v.isShort,
        // what was intended, until the upload starts and the actual values are recorded
        title: f.title || '',
        description: f.description || '',
        tags: Array.isArray(f.tags) ? f.tags.slice() : [],
        ...captionsOf(f),
        privacy: f.privacyStatus || 'private',
        status: 'not uploaded',
        reason: reason,
        link: null,
        at: null,
      };
    });
    return { id: 'run-' + startedAt.replace(/[^0-9]/g, '').slice(0, 14), startedAt, endedAt: null, entries };
  }

  function entryFor(run, id) {
    return run.entries.find((e) => e.id === id) || null;
  }

  // resource: what was actually sent to YouTube (snippet + status), as the uploader built it.
  function markStarted(run, id, resource) {
    const e = entryFor(run, id);
    if (!e || !resource) return;
    e.title = resource.snippet.title;
    e.description = resource.snippet.description;
    e.tags = resource.snippet.tags.slice();
    e.privacy = resource.status.privacyStatus;
    e.reason = '';
    e.at = new Date().toISOString();
  }

  function markUploaded(run, id, link) {
    const e = entryFor(run, id);
    if (!e) return;
    e.status = 'uploaded';
    e.reason = '';
    e.link = link || null;
    e.at = new Date().toISOString();
  }

  function markFailed(run, id, message) {
    const e = entryFor(run, id);
    if (!e) return;
    e.status = 'failed';
    e.reason = message || 'upload failed';
    e.at = new Date().toISOString();
  }

  function markNotUploaded(run, id, reason) {
    const e = entryFor(run, id);
    if (!e) return;
    e.status = 'not uploaded';
    e.reason = reason;
    e.at = new Date().toISOString();
  }

  // Whatever the queue never reached gets the reason the run ended for.
  function finishRun(run, end) {
    const why = end && end.stoppedForQuota ? REASON_QUOTA : end && end.cancelled ? REASON_CANCELLED : 'the queue ended before this video';
    run.entries.forEach((e) => {
      if (e.status === 'not uploaded' && e.reason === REASON_NOT_REACHED) e.reason = why;
    });
    run.endedAt = new Date().toISOString();
    return run;
  }

  function summarize(run) {
    const count = (s) => run.entries.filter((e) => e.status === s).length;
    return { uploaded: count('uploaded'), failed: count('failed'), notUploaded: count('not uploaded'), total: run.entries.length };
  }

  function toText(run) {
    const s = summarize(run);
    const out = [
      'VR ShortsDrop upload log (by VR Developments)',
      `run started: ${run.startedAt}`,
      `run ended: ${run.endedAt || 'still running'}`,
      `videos: ${s.total} · uploaded: ${s.uploaded} · failed: ${s.failed} · not uploaded: ${s.notUploaded}`,
      'note: captions are copy-only in this version (not posted to Instagram; YouTube caption tracks are not uploaded).',
      '',
    ];
    run.entries.forEach((e) => {
      const label = e.status === 'uploaded' ? 'UPLOADED' : e.status === 'failed' ? 'FAILED' : 'NOT UPLOADED';
      out.push(`${String(e.n).padStart(2, '0')} · ${e.file} · ${label}${e.isShort ? ' · Short' : ''}`);
      if (e.reason) out.push(`   reason: ${e.reason}`);
      if (e.link) out.push(`   link: ${e.link}`);
      out.push(`   title used: ${e.title || '(none)'}`);
      out.push('   description used:');
      (e.description || '(empty)').split('\n').forEach((line) => out.push('      ' + line));
      out.push(`   tags used: ${e.tags.length ? e.tags.join(', ') : '(none)'}`);
      out.push(`   privacy: ${e.privacy}`);
      out.push(`   instagram caption (copy only, not posted): ${e.instagramCaption || '(none)'}`);
      out.push(`   youtube captions text (not uploaded): ${e.youtubeCaptions || '(none)'}`);
      out.push('');
    });
    return out.join('\n');
  }

  function fileNameFor(run) {
    return 'shortsdrop-log-' + run.id.replace(/^run-/, '') + '.txt';
  }

  function loadRuns(storage) {
    try {
      const runs = JSON.parse(storage.getItem(KEY) || '[]');
      return Array.isArray(runs) ? runs : [];
    } catch (_) {
      return [];
    }
  }

  // Saves the run in place of its earlier copy (the page saves after every change), keeps the newest KEEP.
  function saveRun(storage, run) {
    const runs = loadRuns(storage).filter((r) => r.id !== run.id);
    runs.push(JSON.parse(JSON.stringify(run)));
    storage.setItem(KEY, JSON.stringify(runs.slice(-KEEP)));
  }

  function clearRuns(storage) {
    storage.removeItem(KEY);
  }

  return { KEY, KEEP, STATUSES, REASON_QUOTA, REASON_CANCELLED, REASON_NOT_TICKED, REASON_ALREADY, newRun, markStarted, markUploaded, markFailed, markNotUploaded, finishRun, summarize, toText, fileNameFor, loadRuns, saveRun, clearRuns };
});

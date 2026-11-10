/* VR ShortsDrop page logic (v2). Plain DOM, no framework, no remote assets. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = ClipStorage.createStore(window.localStorage);
  const transport = ClipUploader.makeXhrTransport();
  const auth = ClipLogin.createAuth(window.localStorage, window.crypto);
  let unlocked = false; // in memory only: a reload asks for the login again
  let finalSummary = null;

  let videos = []; // { id, file, name, size, url, durationSec, width, height, isShort, fields, warnings, include, status, progress, message, link }
  let blocks = [];
  let running = false;
  let cancelled = false;
  let nextId = 1;

  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const fmtTime = (s) => (s == null ? '?' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0'));
  const pct = (f) => Math.round(f * 100) + '%';

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  }

  // ---- channel box -------------------------------------------------------
  function paintChannelState() {
    const ch = store.load();
    const complete = ClipStorage.isComplete(ch);
    $('channel-state').textContent = complete ? 'saved in this browser' : 'not saved';
    const form = $('channel-form');
    ['channelName', 'clientId', 'clientSecret', 'refreshToken'].forEach((f) => { form.elements[f].value = ch[f]; });
  }
  $('channel-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    store.save({ channelName: f.channelName.value, clientId: f.clientId.value, clientSecret: f.clientSecret.value, refreshToken: f.refreshToken.value });
    paintChannelState();
    setMessage('channel details saved in this browser only.');
  });
  $('channel-forget').addEventListener('click', () => {
    store.clear();
    $('channel-form').reset();
    paintChannelState();
    setMessage('channel details removed from this browser.');
  });

  // ---- drop zone and cards ----------------------------------------------
  function addFiles(list) {
    const files = Array.from(list).filter((f) => /\.(mp4|mov)$/i.test(f.name) || /^video\/(mp4|quicktime)$/.test(f.type));
    const skipped = list.length - files.length;
    files.forEach((file) => {
      const v = { id: 'v' + nextId++, file, name: file.name, size: file.size, url: null, durationSec: null, width: 0, height: 0, isShort: false, fields: null, warnings: [], include: true, status: 'waiting', progress: 0, message: '', link: null };
      videos.push(v);
      probe(v);
    });
    if (skipped) setMessage(skipped + ' file(s) skipped: only mp4 and mov are accepted.');
    renderAll();
  }

  function probe(v) {
    const url = URL.createObjectURL(v.file);
    const vid = document.createElement('video');
    vid.preload = 'metadata';
    vid.onloadedmetadata = () => {
      v.durationSec = vid.duration;
      v.width = vid.videoWidth;
      v.height = vid.videoHeight;
      v.isShort = v.height > v.width && v.durationSec <= ClipUploader.SHORT_MAX_SECONDS;
      v.include = v.isShort; // Shorts default to upload; anything else needs a tick
      URL.revokeObjectURL(url);
      renderAll();
    };
    vid.onerror = () => { v.warnings.push('could not read this file to check its length; it may not play in this browser'); URL.revokeObjectURL(url); renderAll(); };
    vid.src = url;
  }

  ['dragenter', 'dragover'].forEach((t) => $('dropzone').addEventListener(t, (e) => { e.preventDefault(); $('dropzone').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => $('dropzone').addEventListener(t, (e) => { e.preventDefault(); $('dropzone').classList.remove('over'); }));
  $('dropzone').addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  $('file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  // ---- paste and split ---------------------------------------------------
  $('split').addEventListener('click', () => {
    blocks = ClipParser.splitBlocks($('mix').value);
    const line = $('block-line');
    if (!blocks.length) { line.textContent = 'no text found yet'; }
    else if (videos.length && blocks.length !== videos.length) {
      line.textContent = `${blocks.length} text block(s) for ${videos.length} video(s): blocks are matched to videos in order, extras are ignored.`;
    } else { line.textContent = `${blocks.length} text block(s) found.`; }
    videos.forEach((v, i) => {
      const block = blocks[i];
      if (!block) { v.fields = null; v.warnings = ['no text block for this video yet']; return; }
      const parsed = ClipParser.parseBlock(block);
      v.fields = { title: parsed.title, description: parsed.description, tags: parsed.tags, instagramCaption: parsed.instagramCaption, youtubeCaptions: parsed.youtubeCaptions, privacyStatus: (v.fields && v.fields.privacyStatus) || 'private' };
      v.warnings = parsed.warnings.slice();
    });
    renderAll();
  });

  // ---- review ----------------------------------------------------------
  function renderReview() {
    const box = $('review');
    box.textContent = '';
    if (!videos.length) { box.appendChild(el('p', { class: 'hint', text: 'drop videos in step 02 first.' })); return; }
    videos.forEach((v, i) => {
      const n = String(i + 1).padStart(2, '0');
      const shortLine = v.durationSec == null
        ? 'checking length…'
        : (v.isShort ? `vertical, ${fmtTime(v.durationSec)}: Short` : `not a Short (${v.width}×${v.height}, ${fmtTime(v.durationSec)}): uploads as a normal video`);

      const titleIn = el('input', { type: 'text', value: v.fields ? v.fields.title : '', maxlength: '200' });
      const descIn = el('textarea', { rows: '4' });
      descIn.value = v.fields ? v.fields.description : '';
      const tagsIn = el('input', { type: 'text', value: v.fields ? v.fields.tags.join(', ') : '' });
      const privacy = el('select', {}, ['private', 'unlisted', 'public'].map((p) => el('option', { value: p, text: p })));
      privacy.value = v.fields ? v.fields.privacyStatus : 'private';
      const includeBox = el('input', { type: 'checkbox' });
      includeBox.checked = v.include;

      titleIn.addEventListener('input', () => { if (v.fields) v.fields.title = titleIn.value; });
      descIn.addEventListener('input', () => { if (v.fields) v.fields.description = descIn.value; });
      tagsIn.addEventListener('input', () => { if (v.fields) v.fields.tags = tagsIn.value.split(',').map((t) => t.trim()).filter(Boolean); });
      privacy.addEventListener('change', () => { if (v.fields) v.fields.privacyStatus = privacy.value; });
      includeBox.addEventListener('change', () => { v.include = includeBox.checked; paintIndex(); });

      const card = el('article', { class: 'rv' }, [
        el('div', { class: 'rv-head' }, [el('span', { class: 'n', text: n }), el('span', { text: v.name }), el('span', { class: 'copy-only', text: fmtSize(v.size) })]),
        el('p', { class: 'warn', text: shortLine }),
        ...v.warnings.map((w) => el('p', { class: 'warn', text: '· ' + w })),
        el('label', {}, ['Title (YouTube, 100 max)', titleIn]),
        el('label', {}, ['Description', descIn]),
        el('div', { class: 'two' }, [
          el('label', {}, ['Tags (comma separated)', tagsIn]),
          el('label', {}, ['Privacy', privacy]),
        ]),
        el('label', {}, ['Instagram caption (copy only, not posted in v1)', el('textarea', { rows: '3', readonly: 'readonly', text: v.fields ? v.fields.instagramCaption : '' })]),
        el('label', {}, ['YouTube captions text (kept for copying; caption tracks are not uploaded in v1)', el('textarea', { rows: '2', readonly: 'readonly', text: v.fields ? v.fields.youtubeCaptions : '' })]),
        el('label', { class: 'check' }, [includeBox, ' upload this video']),
      ]);
      box.appendChild(card);
    });
    $('review-state').textContent = `${videos.length} video(s) · ${videos.filter((v) => v.include).length} to upload`;
  }

  // ---- index and cards ---------------------------------------------------
  function statusText(v) {
    if (v.status === 'uploading') return 'uploading ' + pct(v.progress);
    if (v.status === 'done') return 'done';
    if (v.status === 'failed') return 'failed';
    if (v.status === 'quota') return 'quota reached';
    if (v.status === 'skipped') return 'not uploading';
    return 'waiting';
  }
  function paintIndex() {
    const list = $('index-list');
    list.textContent = '';
    if (!videos.length) list.appendChild(el('li', { class: 'index-empty mono', text: 'no videos yet' }));
    videos.forEach((v, i) => {
      list.appendChild(el('li', {}, [
        el('span', { class: 'n', text: String(i + 1).padStart(2, '0') }),
        el('span', { class: 't', text: v.name, title: v.name }),
        el('span', { class: 'st', text: statusText(v) }),
      ]));
    });
    const done = videos.filter((v) => v.status === 'done').length;
    const total = videos.filter((v) => v.include).length;
    $('count-line').textContent = `${done} of ${total} done`;
    $('progress-count').textContent = `${done} of ${total} done`;
    $('drop-count').textContent = `${videos.length} file(s)`;
  }
  function paintCards() {
    const ul = $('cards');
    ul.textContent = '';
    videos.forEach((v) => {
      const label = v.status === 'uploading' ? 'uploading ' + pct(v.progress) : statusText(v);
      const cls = 's-' + (v.status === 'quota' ? 'quota' : v.status);
      const card = el('li', { class: 'card' }, [
        el('span', { class: 'stamp ' + cls, text: label }),
        el('div', { class: 'name', text: v.name }),
        el('div', { class: 'meta', text: fmtSize(v.size) + (v.durationSec != null ? ' · ' + fmtTime(v.durationSec) : '') }),
        el('div', { class: 'bar' }, [el('span', { style: 'width:' + Math.round(v.progress * 100) + '%' })]),
      ]);
      if (v.message) card.appendChild(el('div', { class: 'meta', text: v.message }));
      if (v.link) card.appendChild(el('div', { class: 'meta' }, [el('a', { href: v.link, target: '_blank', rel: 'noopener', text: 'open on YouTube' })]));
      ul.appendChild(card);
    });
  }
  function renderAll() {
    paintIndex();
    paintCards();
    if (!running) renderReview(); // don't rebuild the form while the queue is posting progress
    $('paste-state').textContent = blocks.length ? `${blocks.length} block(s)` : 'nothing yet';
  }
  function setMessage(text) { $('queue-message').textContent = text; }

  // ---- queue -----------------------------------------------------------
  $('start').addEventListener('click', async () => {
    if (running) return;
    const ch = store.load();
    if (!ClipStorage.isComplete(ch)) { setMessage('fill in and save the channel details first (step 01).'); return; }
    const toRun = videos.filter((v) => v.include && v.fields && v.status !== 'done');
    if (!toRun.length) { setMessage('nothing to upload: tick a video in step 04 and make sure it has text.'); return; }
    running = true; cancelled = false;
    $('start').disabled = true; $('stop').disabled = false;
    // one log entry per video for this run, written before the queue moves so nothing is missed
    const run = ClipRunLog.newRun(new Date().toISOString(), videos);
    finalSummary = null;
    toRun.forEach((v) => { v.status = 'waiting'; v.message = ''; });
    ClipRunLog.saveRun(window.localStorage, run);
    renderAll();

    const items = toRun.map((v) => ({ id: v.id, name: v.name, size: v.size, source: v.file, mime: v.file.type || undefined, fields: { title: v.fields.title, description: v.fields.description, tags: v.fields.tags, privacyStatus: v.fields.privacyStatus, isShort: v.isShort } }));
    const byId = Object.fromEntries(toRun.map((v) => [v.id, v]));
    await ClipUploader.runQueue(items, {
      transport,
      channel: ch,
      isCancelled: () => cancelled,
      onEvent: (e) => {
        const v = byId[e.id];
        if (e.type === 'start' && v) { v.status = 'uploading'; v.progress = 0; setMessage('uploading ' + v.name); ClipRunLog.markStarted(run, e.id, e.resource); }
        if (e.type === 'progress' && v) { v.progress = e.fraction; }
        if (e.type === 'done' && v) { v.status = 'done'; v.progress = 1; v.link = e.url; v.message = ''; ClipRunLog.markUploaded(run, e.id, e.url); }
        if (e.type === 'failed' && v) { v.status = 'failed'; v.message = e.message + '. press start to try again.'; ClipRunLog.markFailed(run, e.id, e.message); }
        if (e.type === 'quota' && v) { v.status = 'quota'; v.message = 'daily quota reached, resume tomorrow'; setMessage('daily quota reached, resume tomorrow. the queue has stopped.'); ClipRunLog.markNotUploaded(run, e.id, ClipRunLog.REASON_QUOTA); }
        if (e.type === 'waiting' && v) { v.status = 'waiting'; }
        if (e.type === 'finished') { finalSummary = e.summary; setMessage(e.summary.stoppedForQuota ? 'stopped: daily quota reached. resume tomorrow.' : cancelled ? 'stopped after the current video.' : 'queue finished.'); }
        renderAll();
        ClipRunLog.saveRun(window.localStorage, run);
        paintLog();
      },
    }).catch((err) => {
      setMessage(err.message || 'the upload could not start');
      toRun.forEach((v) => { if (v.status === 'waiting' || v.status === 'uploading') { v.status = 'failed'; v.message = err.message; ClipRunLog.markFailed(run, v.id, err.message); } });
      renderAll();
    });
    ClipRunLog.finishRun(run, { stoppedForQuota: !!(finalSummary && finalSummary.stoppedForQuota), cancelled });
    ClipRunLog.saveRun(window.localStorage, run);
    paintLog();
    running = false;
    $('start').disabled = false; $('stop').disabled = true;
    renderAll();
  });
  $('stop').addEventListener('click', () => { cancelled = true; setMessage('will stop after the current video.'); });


  // ---- site login (stage 4) ------------------------------------------------
  function gateMessage(text) { $('gate-message').textContent = text; }
  function paintGate() {
    const has = auth.hasAccount();
    const locked = !unlocked;
    $('gate-create').hidden = has;
    $('gate-signin').hidden = !has;
    $('gate-state').textContent = locked ? 'locked' : 'signed in';
    $('gate').hidden = !locked;
    document.querySelectorAll('[data-app]').forEach((n) => { n.hidden = locked; });
    $('account-bar').hidden = locked;
    $('account-email').textContent = auth.accountEmail() || '';
    if (has && locked) $('gate-signin').elements.email.value = auth.accountEmail() || '';
  }
  $('gate-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (f.password.value !== f.password2.value) { gateMessage('the two passwords do not match.'); return; }
    const r = await auth.createAccount(f.email.value, f.password.value);
    f.password.value = ''; f.password2.value = '';
    if (!r.ok) { gateMessage(r.error); return; }
    unlocked = true;
    paintGate();
    setMessage('account made on this device. another phone needs its own account.');
  });
  $('gate-signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const r = await auth.signIn(f.email.value, f.password.value);
    f.password.value = '';
    if (!r.ok) { gateMessage(r.error); return; }
    unlocked = true;
    gateMessage('');
    paintGate();
  });
  $('signout').addEventListener('click', () => {
    if (running) { setMessage('stop the queue before signing out.'); return; }
    unlocked = false;
    paintGate();
    gateMessage('signed out. sign in again to continue.');
  });
  $('erase').addEventListener('click', () => {
    if (running) { setMessage('stop the queue before erasing this device.'); return; }
    if (!window.confirm("erase this device's login and the channel details saved in this browser? this can't be undone.")) return;
    auth.eraseAccount();
    store.clear();
    ClipRunLog.clearRuns(window.localStorage);
    paintLog();
    unlocked = false;
    $('channel-form').reset();
    paintChannelState();
    paintGate();
    gateMessage('this device no longer has an account. make a new one to continue.');
  });

  // ---- run log (stage 7) -------------------------------------------------
  function latestRun() {
    const runs = ClipRunLog.loadRuns(window.localStorage);
    return runs.length ? runs[runs.length - 1] : null;
  }
  function paintLog() {
    const list = $('log-list');
    list.textContent = '';
    const run = latestRun();
    $('log-download').disabled = !run;
    if (!run) {
      $('log-state').textContent = 'no runs yet';
      list.appendChild(el('li', { class: 'hint mono', text: 'no upload run yet in this browser. the log of each run appears here as its videos are handled.' }));
      return;
    }
    const s = ClipRunLog.summarize(run);
    $('log-state').textContent = `${s.uploaded} uploaded · ${s.failed} failed · ${s.notUploaded} not uploaded`;
    run.entries.forEach((e) => {
      const cls = e.status === 'uploaded' ? 's-done' : e.status === 'failed' ? 's-failed' : 's-waiting';
      const kids = [el('span', { class: 'stamp ' + cls, text: e.status }), el('strong', { text: String(e.n).padStart(2, '0') + ' · ' + e.file })];
      if (e.reason) kids.push(el('p', { class: 'why', text: 'reason: ' + e.reason }));
      if (e.link) kids.push(el('p', { class: 'why' }, [el('a', { href: e.link, target: '_blank', rel: 'noopener', text: 'open on YouTube' })]));
      kids.push(el('p', { class: 'why', text: 'title used: ' + (e.title || '(none)') }));
      kids.push(el('p', { class: 'used', text: 'description used: ' + (e.description || '(none)') }));
      kids.push(el('p', { class: 'why', text: 'tags used: ' + (e.tags.length ? e.tags.join(', ') : '(none)') }));
      list.appendChild(el('li', {}, kids));
    });
  }
  $('log-download').addEventListener('click', () => {
    const run = latestRun();
    if (!run) return;
    const url = URL.createObjectURL(new Blob([ClipRunLog.toText(run)], { type: 'text/plain;charset=utf-8' }));
    const a = el('a', { href: url, download: ClipRunLog.fileNameFor(run) });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  paintChannelState();
  renderAll();
  paintGate();
  paintLog();
})();

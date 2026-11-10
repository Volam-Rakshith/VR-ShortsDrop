const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const js = { app: read('src/app.js'), uploader: read('src/uploader.js'), parser: read('src/parser.js'), storage: read('src/storage.js'), login: read('src/login.js') };

test('page: title, viewport, landmarks and the honest copy are on screen', () => {
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<main/);
  assert.match(html, /<aside/);
  assert.match(html, /uploads only run while this page is open/);
  assert.match(html, /browser storage is not a vault/);
  assert.match(html, /anyone with access to this browser can read these values/);
  assert.match(html, /daily quota/);
});

test('page: the numbered steps (01 to 06, the last is the log) are there in order', () => {
  const nums = [...html.matchAll(/class="num mono">(\d\d)</g)].map((m) => m[1]);
  assert.deepEqual(nums, ['01', '02', '03', '04', '05', '06']);
});

test('page: every local script and stylesheet it names exists', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((r) => !r.startsWith('http'));
  assert.ok(refs.length >= 5);
  refs.forEach((r) => assert.ok(fs.existsSync(path.join(ROOT, r)), 'missing ' + r));
});

test('page: no remote assets, fonts or trackers', () => {
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(css, /@import|url\(\s*https?:/);
});

test('secrets: no real Google or YouTube credential pattern in any shipped file', () => {
  const all = html + css + Object.values(js).join('\n');
  assert.doesNotMatch(all, /AIza[0-9A-Za-z_-]{30,}/);
  assert.doesNotMatch(all, /GOCSPX-[0-9A-Za-z_-]{10,}/);
  assert.doesNotMatch(all, /ya29\.[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(all, /1\/\/[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(all, /[0-9]{6,}-[0-9a-z]{20,}\.apps\.googleusercontent\.com/);
});

test('privacy: channel details only leave the page for Google (token + YouTube upload endpoints)', () => {
  // Only the uploader talks to the network, and only to its two Google URLs.
  const netCalls = /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|importScripts)\b/;
  assert.match(js.uploader, netCalls);
  assert.doesNotMatch(js.app, netCalls);
  assert.doesNotMatch(js.parser, netCalls);
  assert.doesNotMatch(js.storage, netCalls);
  const hosts = [...(js.uploader.matchAll(/https?:\/\/([a-z0-9.-]+)/g))].map((m) => m[1]);
  // www.youtube.com appears only in the "open on YouTube" watch link built from the reply, never as a request.
  assert.deepEqual([...new Set(hosts)].sort(), ['oauth2.googleapis.com', 'www.googleapis.com', 'www.youtube.com']);
  assert.doesNotMatch(js.uploader, /method:\s*'GET'/);
  // Channel details are stored in localStorage and read from nowhere else.
  assert.match(js.storage, /shortsdrop\.channel\.v1/);
  assert.doesNotMatch(js.app, /sessionStorage|indexedDB|document\.cookie/);
});

test('scope: no Instagram posting and no YouTube collaborator fields in v1', () => {
  const all = html + Object.values(js).join('\n');
  assert.doesNotMatch(all, /collaborator/i);
  assert.doesNotMatch(all, /graph\.facebook\.com|graph\.instagram\.com/);
  assert.match(html + js.app, /not posted in v1/);
});

test('mobile: layout collapses to one column and nothing is set to a fixed wide width', () => {
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.doesNotMatch(css, /(^|[^-])width:\s*\d{3,}px/m); // max-width caps are fine; a fixed wide width is not
});

test('upload page: Shorts rule and the 100-character title rule are wired to the uploader', () => {
  assert.match(js.app, /SHORT_MAX_SECONDS/);
  assert.match(js.uploader, /SHORT_MAX_SECONDS = 60/);
  assert.match(js.uploader, /#Shorts/);
  assert.match(js.parser, /YT_TITLE_MAX = 100/);
});

test('login gate (stage 4): the login copy is on screen and the gate hides the steps until signed in', () => {
  assert.match(html, /another phone needs its own account/);
  assert.match(html, /a static page cannot fully protect your keys from someone who has this same phone/);
  assert.match(html, /id="gate"/);
  assert.match(html, /id="gate-create"/);
  assert.match(html, /id="gate-signin"/);
  // every numbered step is marked for the gate to hide
  const steps = [...html.matchAll(/<section class="step" data-app id="step-/g)];
  assert.equal(steps.length, 6);
  assert.match(js.app, /ClipLogin\.createAuth\(window\.localStorage, window\.crypto\)/);
  // login.js loads before app.js
  assert.ok(html.indexOf('src/login.js') > -1 && html.indexOf('src/login.js') < html.indexOf('src/app.js'));
});

test('login (stage 4): password is hashed with WebCrypto PBKDF2 and a per-device salt; no network in login.js', () => {
  assert.match(js.login, /PBKDF2/);
  assert.match(js.login, /crypto\.subtle|subtle\.deriveBits|c\.subtle/);
  assert.match(js.login, /getRandomValues/);
  assert.doesNotMatch(js.login, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/);
  assert.doesNotMatch(js.login, /sessionStorage|indexedDB|document\.cookie/);
});

test('branding (stage 5): VR ShortsDrop, by VR Developments, on the page title, header and footer', () => {
  assert.match(html, /<title>VR ShortsDrop: upload queue, by VR Developments<\/title>/);
  assert.match(html, /VR SHORTSDROP/);
  assert.match(html, /by VR Developments/);
  assert.match(html, /<footer class="foot mono">VR ShortsDrop v2 · by VR Developments/);
  assert.doesNotMatch(html + css + Object.values(js).join('\n'), /clip ?desk/i);
});

test('log (stage 7): a LOG step with a download button, loaded before the page script, and no network in the log code', () => {
  assert.match(html, /id="step-log"/);
  assert.match(html, /id="log-download"/);
  assert.match(html, /Download log \(\.txt\)/);
  assert.match(html, /src="src\/runlog\.js"/);
  assert.ok(html.indexOf('src/runlog.js') < html.indexOf('src/app.js'));
  assert.doesNotMatch(js.app.split('// ---- run log')[1] || '', /fetch\(|XMLHttpRequest/);
  assert.doesNotMatch(read('src/runlog.js'), /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/);
  assert.match(js.app, /ClipRunLog\.toText\(run\)/);
});


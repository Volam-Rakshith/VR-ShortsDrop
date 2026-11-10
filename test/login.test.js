const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, KEY, MIN_PASSWORD, validEmail } = require('../src/login.js');

// A tiny localStorage stand-in: one per "device".
function device() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    raw: () => data.get(KEY) || null,
  };
}

const crypto = globalThis.crypto; // WebCrypto: the same API the browser has

test('login: an account is made on the device and the password is never stored as text', async () => {
  const phone = device();
  const auth = createAuth(phone, crypto);
  assert.equal(auth.hasAccount(), false);
  const made = await auth.createAccount('Rakshith@Example.com ', 'correct horse battery');
  assert.equal(made.ok, true);
  assert.equal(made.email, 'rakshith@example.com');
  assert.equal(auth.hasAccount(), true);
  const raw = phone.raw();
  assert.ok(raw);
  assert.doesNotMatch(raw, /correct horse battery/);
  const rec = JSON.parse(raw);
  assert.equal(Buffer.from(rec.salt, 'base64').length, 16, 'a 16-byte salt made on this device');
  assert.equal(Buffer.from(rec.hash, 'base64').length, 32, 'a 256-bit PBKDF2 hash');
  assert.ok(rec.iterations >= 100000);
});

test('login: right password opens it, wrong password does not, and the message does not say which part was wrong', async () => {
  const phone = device();
  const auth = createAuth(phone, crypto);
  await auth.createAccount('me@example.com', 'long-enough-pass');
  const ok = await auth.signIn('ME@example.com', 'long-enough-pass');
  assert.equal(ok.ok, true);
  const bad = await auth.signIn('me@example.com', 'long-enough-pasz');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'wrong email or password.');
  const wrongEmail = await auth.signIn('other@example.com', 'long-enough-pass');
  assert.equal(wrongEmail.ok, false);
  assert.equal(wrongEmail.error, bad.error, 'a wrong email and a wrong password read the same');
  const empty = await auth.signIn('me@example.com', '');
  assert.equal(empty.ok, false);
});

test('login: another phone (a fresh device with no stored account) cannot open the account', async () => {
  const phoneA = device();
  const phoneB = device();
  await createAuth(phoneA, crypto).createAccount('me@example.com', 'long-enough-pass');
  const onB = createAuth(phoneB, crypto);
  assert.equal(onB.hasAccount(), false);
  const r = await onB.signIn('me@example.com', 'long-enough-pass');
  assert.equal(r.ok, false);
  assert.match(r.error, /only works on the device that made it/);
  // and it can make its own account, which gets its own salt and hash
  const own = await onB.createAccount('me@example.com', 'long-enough-pass');
  assert.equal(own.ok, true);
  const a = JSON.parse(phoneA.raw());
  const b = JSON.parse(phoneB.raw());
  assert.notEqual(a.salt, b.salt, 'per-device salt');
  assert.notEqual(a.hash, b.hash, 'same password, different device, different hash');
});

test('login: a second account cannot be made over an existing one on the same device', async () => {
  const phone = device();
  const auth = createAuth(phone, crypto);
  await auth.createAccount('me@example.com', 'long-enough-pass');
  const again = await auth.createAccount('someone@example.com', 'another-long-pass');
  assert.equal(again.ok, false);
  assert.equal(auth.accountEmail(), 'me@example.com');
});

test('login: short passwords and bad emails are refused before anything is stored', async () => {
  const phone = device();
  const auth = createAuth(phone, crypto);
  const short = await auth.createAccount('me@example.com', 'x'.repeat(MIN_PASSWORD - 1));
  assert.equal(short.ok, false);
  assert.match(short.error, /at least 8/);
  const badMail = await auth.createAccount('not-an-email', 'long-enough-pass');
  assert.equal(badMail.ok, false);
  assert.equal(phone.raw(), null, 'nothing stored after a refusal');
  assert.equal(validEmail('a@b.co'), true);
  assert.equal(validEmail('a b@c.co'), false);
});

test('login: erasing the account on this device removes it', async () => {
  const phone = device();
  const auth = createAuth(phone, crypto);
  await auth.createAccount('me@example.com', 'long-enough-pass');
  auth.eraseAccount();
  assert.equal(auth.hasAccount(), false);
  const r = await auth.signIn('me@example.com', 'long-enough-pass');
  assert.equal(r.ok, false);
});

test('login: a damaged record is treated as no account, not as a crash', async () => {
  const phone = device();
  phone.setItem(KEY, '{not json');
  const auth = createAuth(phone, crypto);
  assert.equal(auth.hasAccount(), false);
});

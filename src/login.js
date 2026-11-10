/*
 * Site login for VR ShortsDrop (stage 4).
 * The person picks an email and a password on this device. The password itself is never
 * stored: the record keeps a PBKDF2-SHA-256 hash with a random salt made on this device when
 * the account was created (WebCrypto). The record lives only in this browser's localStorage,
 * so an account made on one phone does not exist on another phone.
 * Honest limit, also shown on the page: a static page cannot keep its keys safe from someone
 * who has this same phone and can open this browser. This is a lock on the page, not a vault.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipLogin = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const KEY = 'shortsdrop.account.v1';
  const ITERATIONS = 210000;
  const SALT_BYTES = 16;
  const MIN_PASSWORD = 8;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function normEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function validEmail(email) {
    const e = normEmail(email);
    return e.length <= 254 && EMAIL_RE.test(e);
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  // storage: a localStorage-like object. cryptoImpl: an object with getRandomValues and subtle (window.crypto or Node's).
  function createAuth(storage, cryptoImpl) {
    const c = cryptoImpl;

    async function derive(password, salt, iterations) {
      const key = await c.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await c.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
      return new Uint8Array(bits);
    }

    function load() {
      const raw = storage.getItem(KEY);
      if (!raw) return null;
      try {
        const rec = JSON.parse(raw);
        return rec && rec.v === 1 && rec.email && rec.salt && rec.hash && rec.iterations ? rec : null;
      } catch (_) {
        return null;
      }
    }

    return {
      hasAccount() { return load() !== null; },
      accountEmail() { const rec = load(); return rec ? rec.email : null; },

      async createAccount(email, password) {
        if (load()) return { ok: false, error: 'this device already has an account. sign in, or erase it first.' };
        if (!validEmail(email)) return { ok: false, error: 'type a valid email address.' };
        if (String(password || '').length < MIN_PASSWORD) return { ok: false, error: `the password needs at least ${MIN_PASSWORD} characters.` };
        const salt = new Uint8Array(SALT_BYTES);
        c.getRandomValues(salt);
        const hash = await derive(String(password), salt, ITERATIONS);
        const rec = {
          v: 1,
          email: normEmail(email),
          salt: toB64(salt),
          iterations: ITERATIONS,
          hash: toB64(hash),
          createdAt: new Date().toISOString(),
        };
        storage.setItem(KEY, JSON.stringify(rec));
        return { ok: true, email: rec.email };
      },

      async signIn(email, password) {
        const rec = load();
        if (!rec) return { ok: false, error: 'no account on this device. this login only works on the device that made it. make one here.' };
        if (normEmail(email) !== rec.email || !password) return { ok: false, error: 'wrong email or password.' };
        const hash = await derive(String(password), fromB64(rec.salt), rec.iterations);
        if (!sameBytes(hash, fromB64(rec.hash))) return { ok: false, error: 'wrong email or password.' };
        return { ok: true, email: rec.email };
      },

      eraseAccount() { storage.removeItem(KEY); },
    };
  }

  return { KEY, ITERATIONS, MIN_PASSWORD, validEmail, createAuth };
});

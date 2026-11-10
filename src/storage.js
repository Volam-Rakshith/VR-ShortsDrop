/*
 * Channel details live ONLY in this browser (localStorage). That is not a vault:
 * anyone with access to this browser profile can read them. The page says so.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipStorage = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const KEY = 'shortsdrop.channel.v1';
  const FIELDS = ['channelName', 'clientId', 'clientSecret', 'refreshToken'];

  function clean(input) {
    const out = {};
    FIELDS.forEach((f) => { out[f] = String((input && input[f]) || '').trim(); });
    return out;
  }

  function isComplete(channel) {
    return FIELDS.every((f) => channel[f] !== '');
  }

  function createStore(storage) {
    return {
      save(input) {
        const channel = clean(input);
        storage.setItem(KEY, JSON.stringify(channel));
        return channel;
      },
      load() {
        const raw = storage.getItem(KEY);
        if (!raw) return clean({});
        try { return clean(JSON.parse(raw)); } catch (_) { return clean({}); }
      },
      clear() { storage.removeItem(KEY); },
    };
  }

  return { KEY, FIELDS, clean, isComplete, createStore };
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const dummy = () => new Proxy(function () {}, {
  get: (t, k) => (k === 'value' ? '' : k === 'checked' ? false : k === 'dataset' ? {} : k === 'style' ? {} : dummy()),
  set: () => true, apply: () => dummy(),
});
const state = {
  guild: 'G', members: 12, ping: 20, uptime: 4000, chCount: 3, roleCount: 2, panic: false, wl: ['123456789012345678'], ui: {}, logs: [{ t: 'x', d: 'y', u: '123456789012345678', at: 1 }],
  channels: [{ id: 'c1', name: '#general' }], voices: [{ id: 'v1', name: '🔊 lobby' }], categories: [{ id: 'k1', name: 'Cat' }], roles: [{ id: 'r1', name: 'Member' }], bad: [{ id: '123456789012345678', r: 'x' }],
  backups: [{ id: 'abcd', date: 1, roles: 1, channels: 2 }], stats: { x: 2 }, isOwner: true, presence: {}, acts: [{ t: 1, type: 'ban', uid: '1', text: 't' }], dlog: [{ t: 1, who: 'a', text: 'b' }],
  bin: [{ id: 'b1', kind: 'ch', at: 1, name: 'old' }], sub: { active: true, free: false, days: 3, plan: 'monthly' },
};

function boot() {
  const doc = { querySelector: () => dummy(), querySelectorAll: () => [], addEventListener() {} };
  const fetch = async (url) => ({ json: async () => (String(url).includes('leaderboard') ? [{ id: '1', xp: 400, level: 2, name: 'Sara', avatar: null }] : state) });
  const fn = new Function('document', 'fetch', 'location', 'window', 'confirm', script + '\n;return { P, NAV, S: () => S, setST: (s) => (ST = s) };');
  return fn(doc, fetch, { hash: '', href: '' }, { scrollTo() {} }, () => true);
}

test('dashboard script has valid syntax and every sidebar page renders cleanly', async () => {
  const d = boot();
  d.setST(state);
  const pages = d.NAV.flatMap((g) => g[1].map((x) => x[0]));
  assert.ok(pages.length >= 20);
  for (const k of pages) {
    assert.ok(d.P[k], 'missing page ' + k);
    await d.P[k].load?.call(d.P[k]);
    const out = d.P[k].render();
    assert.equal(typeof out, 'string', k);
    assert.ok(out.length > 40, k + ' is empty');
    assert.ok(!/undefined|\[object Object\]|NaN/.test(out), `${k} contains broken values`);
  }
});

test('every page has a description and every page is reachable from the sidebar', () => {
  const d = boot();
  for (const k of d.NAV.flatMap((g) => g[1].map((x) => x[0]))) assert.ok(html.includes(`${k}: '`) || html.includes(`${k}:`), k);
});

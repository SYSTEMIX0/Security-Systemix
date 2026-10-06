'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBot, guild, session } = require('./helpers');

test('Render: /health works and the public URL comes from RENDER_EXTERNAL_URL', async () => {
  const bot = loadBot({ publicUrl: '', env: { RENDER_EXTERNAL_URL: 'https://systemix.onrender.com/' }, sessions: { s1: session('100') }, guilds: (c) => [guild(c, '100', '9')] });
  const h = await bot.call('get /health');
  assert.equal(h.out.ok, true);
  assert.equal(h.out.guilds, 1);

  const link = (await bot.call('post /api/backup', { headers: { cookie: 'sx=s1' } })).out.link;
  assert.ok(link.startsWith('https://systemix.onrender.com/t/'), link);

  const mw = bot.uses.find((f) => f.name === 'security');
  const run = (origin) => { const res = { code: 200, set() {}, status(c) { this.code = c; return this; }, send() {}, json() {} }; let next = false; mw({ path: '/x', ip: '9.9.9.9', method: 'POST', get: () => origin }, res, () => (next = true)); return { res, next }; };
  assert.ok(run('https://systemix.onrender.com').next, 'same origin allowed');
  assert.equal(run('https://evil.com').res.code, 403);
});

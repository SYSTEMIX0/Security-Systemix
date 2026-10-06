'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBot, guild, session } = require('./helpers');

const OWN = { cookie: 'sx=owner' }, USER = { cookie: 'sx=user' };
function setup() {
  const bot = loadBot({
    owner: 'OWN',
    sessions: { owner: session('100', 'OWN', []), user: session('100', 'U1') },
    guilds: (calls) => [guild(calls, '100', '9'), guild(calls, '200', 'OWN')],
  });
  const cfg = (headers, body) => bot.call('put /api/config', { headers, body });
  return { bot, g: bot.guilds.get('100'), mine: bot.guilds.get('200'), cfg, owner: (key, body) => bot.call(key, { headers: OWN, body }) };
}

test('new server starts suspended: bot does nothing, commands answer politely, customer API blocked', async () => {
  const { bot, g, cfg } = setup();
  await cfg(OWN, { badWords: 'badword', sec: { words: true } });
  bot.calls.length = 0;
  await bot.fire('messageCreate', bot.msg(g, 'badword'));
  assert.ok(!bot.calls.includes('delete'));
  await bot.fire('interactionCreate', { guild: g, isRepliable: () => true, reply: async (x) => bot.calls.push('reply:' + x.content) });
  assert.ok(bot.calls.some((c) => c.startsWith('reply:⛔')));
  const blocked = await cfg(USER, {});
  assert.equal(blocked.code, 402);
  const st = await bot.call('get /api/state', { headers: USER });
  assert.equal(st.out.sub.active, false);
});

test('customers cannot use owner API or owner page', async () => {
  const { bot } = setup();
  assert.equal((await bot.call('post /api/owner/sub', { headers: USER, body: { id: '100', action: 'activate' } })).code, 403);
  assert.equal((await bot.call('get /owner', { headers: USER })).code, 403);
  assert.equal((await bot.call('get /api/owner/state', { headers: USER })).code, 403);
});

test('owner activates, extends, expires and suspends', async () => {
  const { bot, g, cfg, owner } = setup();
  await cfg(OWN, { badWords: 'badword', sec: { words: true }, logCh: 'c1' });
  bot.calls.length = 0;
  const act = await owner('post /api/owner/sub', { id: '100', action: 'activate', days: 30, plan: 'monthly', note: 'ahmed' });
  assert.ok(act.out.ok);
  assert.ok(bot.calls.includes('send:embed') && bot.calls.includes('dm-owner') && bot.calls.includes('register'), 'server notified + commands registered');
  bot.calls.length = 0;
  await bot.fire('messageCreate', bot.msg(g, 'badword'));
  assert.ok(bot.calls.includes('delete'), 'works after activation');
  await owner('post /api/owner/sub', { id: '100', action: 'extend', days: 10 });
  assert.equal((await bot.call('get /api/state', { headers: USER })).out.sub.days, 40);

  const real = Date.now;
  Date.now = () => real() + 45 * 864e5;
  try {
    bot.calls.length = 0;
    await bot.fire('messageCreate', bot.msg(g, 'badword'));
    assert.ok(!bot.calls.includes('delete'), 'stops after expiry');
  } finally { Date.now = real; }

  await owner('post /api/owner/sub', { id: '100', action: 'suspend' });
  bot.calls.length = 0;
  await bot.fire('messageCreate', bot.msg(g, 'badword'));
  assert.ok(!bot.calls.includes('delete'), 'stops after manual suspend');
});

test('owner panel: state, settings, broadcast, blacklist, free owner servers', async () => {
  const { bot, owner } = setup();
  const st = await owner('get /api/owner/state');
  assert.equal(st.out.rows.length, 2);
  assert.ok(st.out.rows.some((r) => r.status === 'free'));
  assert.match(st.out.invite, /oauth2\/authorize/);
  assert.ok((await owner('post /api/owner/settings', { on: true, newServers: 'trial', trialDays: 5, contact: '@me', msg: 'renew', notifyDays: 3, leaveDays: 0 })).out.ok);
  bot.calls.length = 0;
  assert.equal((await owner('post /api/owner/broadcast', { target: 'all', text: 'hello' })).out.n, 2);
  bot.calls.length = 0;
  await owner('post /api/owner/blacklist', { id: '100000000000000000', add: true });
  await bot.fire('guildCreate', guild(bot.calls, '100000000000000000', '1'));
  assert.ok(bot.calls.some((c) => c.startsWith('leave:1000')));
  assert.ok(String((await bot.call('get /servers', { headers: USER })).out).includes('/select/'));
  assert.ok(!String((await bot.call('get /servers', { headers: USER })).out).includes('دعوة البوت'));
});

test('multiple owners: every id in OWNER_ID is an owner and their servers are free', async () => {
  const bot = loadBot({
    owner: 'OWN1, OWN2',
    sessions: { a: session('100', 'OWN1', []), b: session('100', 'OWN2', []), c: session('100', 'U9') },
    guilds: (calls) => [guild(calls, '100', '9'), guild(calls, '200', 'OWN2')],
  });
  for (const k of ['a', 'b']) assert.equal((await bot.call('get /api/owner/state', { headers: { cookie: 'sx=' + k } })).out.rows.length, 2);
  assert.equal((await bot.call('get /api/owner/state', { headers: { cookie: 'sx=c' } })).code, 403);
  const rows = (await bot.call('get /api/owner/state', { headers: { cookie: 'sx=b' } })).out.rows;
  assert.equal(rows.find((r) => r.id === '200').status, 'free', 'server owned by the second owner is free');
  assert.equal(rows.find((r) => r.id === '100').status, 'suspended');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBot, guild, session, channel, Coll } = require('./helpers');

const H = { cookie: 'sx=s1' };
function setup() {
  const bot = loadBot({ sessions: { s1: session('100') }, guilds: (calls) => [guild(calls, '100', '9')] });
  const g = bot.guilds.get('100');
  bot.calls.length = 0;
  return { bot, g, calls: bot.calls, cfg: (body) => bot.call('put /api/config', { headers: H, body }), get: (k, body) => bot.call(k, { headers: H, body }) };
}

test('logs matrix: per-event switch, channel and custom template', async () => {
  const { bot, g, calls, cfg } = setup();
  g.channels.cache.set('c2', channel(calls, 'c2', { name: 'logs' }));
  await cfg({ lg: { msgdel: { on: false }, join: { on: true, ch: 'c2', t: 'NEW', d: 'x {details}' } } });
  calls.length = 0;
  await bot.fire('messageDelete', { guild: g, author: { id: '5', bot: false }, channelId: 'c1', content: 'gone' });
  assert.equal(calls.filter((c) => c === 'send:embed').length, 0, 'disabled event is silent');
  await bot.fire('guildMemberAdd', { id: '7', guild: g, user: { bot: false, username: 'u', createdTimestamp: Date.now() - 864e7, displayAvatarURL: () => null }, roles: g.member.roles, send: async () => {}, kick: async () => {} });
  assert.ok(calls.includes('send:embed'), 'enabled event is logged');
});

test('recycle bin: deleted channel/role are kept and can be restored', async () => {
  const { bot, g, calls, get } = setup();
  await bot.fire('channelDelete', { ...channel(calls, 'x1', { name: 'secret' }), guild: g });
  await bot.fire('roleDelete', { guild: g, name: 'VIP', color: 1, hoist: false, managed: false, permissions: { bitfield: 8n } });
  const st = await get('get /api/state');
  assert.equal(st.out.bin.length, 2);
  calls.length = 0;
  for (const e of st.out.bin) assert.ok((await get('post /api/bin/restore', { id: e.id })).out.ok);
  assert.ok(calls.includes('create:secret') && calls.includes('rolecreate:VIP'));
  assert.equal((await get('get /api/state')).out.bin.length, 0);
});

test('starboard posts a message once it reaches the threshold', async () => {
  const { bot, g, calls, cfg } = setup();
  g.channels.cache.set('star', channel(calls, 'star', { name: 'star' }));
  await cfg({ star: { on: true, ch: 'star', n: 2, emoji: '⭐' } });
  const users = new Coll([['a', { id: 'a', bot: false }], ['b', { id: 'b', bot: false }]]);
  const message = { partial: false, guild: g, channelId: 'c1', id: 'm1', author: { id: 'z', username: 'z', displayAvatarURL: () => null }, content: 'nice', url: 'u', createdAt: new Date(), attachments: new Coll() };
  calls.length = 0;
  await bot.fire('messageReactionAdd', { partial: false, message, emoji: { name: '⭐' }, users: { fetch: async () => users } }, { id: 'a', bot: false });
  assert.ok(calls.some((c) => c === 'send:⭐ **2** | <#c1>'));
});

test('temp voice: create on join, delete when empty', async () => {
  const { bot, g, calls, cfg } = setup();
  await cfg({ tv: { on: true, ch: 'lobby', name: '🔊 {user}', limit: 0 } });
  calls.length = 0;
  const member = { id: '5', displayName: 'Sara', user: { bot: false }, voice: { setChannel: async () => calls.push('moved') } };
  await bot.fire('voiceStateUpdate', { channelId: null, guild: g }, { guild: g, channelId: 'lobby', member, channel: { parentId: null } });
  assert.ok(calls.includes('create:🔊 Sara') && calls.includes('moved'));
});

test('stat channels are renamed from templates', async () => {
  const { g, calls, cfg, get } = setup();
  g.channels.cache.set('v1', channel(calls, 'v1', { name: 'old', type: 'GuildVoice' }));
  await cfg({ stats: [{ ch: 'v1', tpl: 'Members: {members}' }] });
  calls.length = 0;
  assert.equal((await get('post /api/stats/update')).out.n, 1);
  assert.ok(calls.includes('rename:Members: 7'));
});

test('embed sender, leaderboard, bot nickname', async () => {
  const { calls, cfg, get } = setup();
  assert.ok((await get('post /api/embed', { channel: 'c1', title: 'Hi', desc: 'x', color: '#ff0000' })).out.ok);
  assert.equal((await get('post /api/embed', { channel: 'c1' })).out.ok, false);
  await cfg({});
  assert.ok(Array.isArray((await get('get /api/leaderboard')).out));
  assert.ok((await get('post /api/botnick', { nick: 'Sys' })).out.ok);
  assert.ok(calls.includes('nick:Sys'));
});

test('web security middleware: headers, rate limit, same-origin only', () => {
  const bot = loadBot({ guilds: (calls) => [guild(calls, '100', '9')] });
  const mw = bot.uses.find((f) => f.name === 'security');
  const run = (req) => { const res = { h: {}, code: 200, set(o) { Object.assign(this.h, o); }, status(c) { this.code = c; return this; }, send() {}, json() {} }; let next = false; mw({ path: '/x', ip: '1.1.1.1', get: (k) => req.headers?.[k], ...req }, res, () => (next = true)); return { res, next }; };
  const a = run({ method: 'GET' });
  assert.ok(a.next && a.res.h['X-Frame-Options'] === 'DENY');
  assert.equal(run({ method: 'POST', headers: { origin: 'https://evil.com' } }).res.code, 403);
  assert.ok(run({ method: 'POST', headers: { origin: 'http://localhost:3000' } }).next);
  let blocked = 0;
  for (let i = 0; i < 305; i++) if (run({ method: 'GET', ip: '2.2.2.2' }).res.code === 429) blocked++;
  assert.ok(blocked > 0);
});

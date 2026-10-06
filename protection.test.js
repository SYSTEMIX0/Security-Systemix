'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBot, guild, session } = require('./helpers');

function setup() {
  const bot = loadBot({ sessions: { s1: session('100') }, guilds: (calls) => [guild(calls, '100', '9')] });
  const g = bot.guilds.get('100');
  bot.calls.length = 0;
  return { g, bot, calls: bot.calls, cfg: (body) => bot.call('put /api/config', { headers: { cookie: 'sx=s1' }, body }) };
}

test('config is saved and returned in state', async () => {
  const { bot, cfg } = setup();
  const r = await cfg({ spamMsgs: 4, muteMin: 30, badWords: 'x', ar: [{ t: 'a', r: 'b' }], lg: { join: { on: true } } });
  assert.equal(r.out.ok, true);
  const st = await bot.call('get /api/state', { headers: { cookie: 'sx=s1' } });
  assert.equal(st.out.ui.spamMsgs, 4);
  assert.equal(st.out.ui.lg.join.on, true);
  assert.ok(Array.isArray(st.out.channels) && Array.isArray(st.out.voices) && Array.isArray(st.out.roles));
});

test('content filters: bad words, invites, phishing, caps, spam, auto-reply', async () => {
  const { g, bot, calls, cfg } = setup();
  await cfg({ badWords: 'badword', blockInvites: true, allowInv: 'mine', capsOn: true, capsPct: 60, spamMsgs: 4, spamSec: 5, muteMin: 30, ar: [{ t: 'ping', r: 'pong', exact: true }], sec: { words: true, link: true, spam: true } });
  const run = async (text) => { calls.length = 0; await bot.fire('messageCreate', bot.msg(g, text)); return [...calls]; };
  assert.ok((await run('a BADWORD here')).includes('delete'));
  assert.ok((await run('join discord.gg/evil')).includes('delete'));
  assert.ok(!(await run('join discord.gg/mine')).includes('delete'));
  assert.ok((await run('https://discord-nitro.xyz/free')).includes('delete'));
  assert.ok((await run('HELLO EVERYONE LOOK AT THIS')).includes('delete'));
  assert.ok((await run('ping')).includes('reply:pong'));
  calls.length = 0;
  for (let i = 0; i < 4; i++) await bot.fire('messageCreate', bot.msg(g, 'x' + i));
  assert.ok(calls.includes('delete'), 'spam');
  assert.ok(!(await run('hello normal')).includes('delete'));
});

test('join: auto role, welcome DM', async () => {
  const { g, bot, calls, cfg } = setup();
  await cfg({ autorole: 'r1', welcome: { on: true, ch: 'c1', msg: 'hi {user}', dm: true, dmMsg: 'dm {server}' } });
  calls.length = 0;
  await bot.fire('guildMemberAdd', { id: '7', guild: g, user: { bot: false, username: 'u', createdTimestamp: Date.now() - 864e7, displayAvatarURL: () => null }, roles: g.member.roles, send: async (t) => calls.push('dm:' + t), kick: async () => {} });
  assert.ok(calls.includes('addrole:r1'));
  assert.ok(calls.includes('dm:dm G100'));
});

test('anti-nuke obeys dashboard toggles (ON, OFF, master OFF)', async () => {
  const { g, bot, calls, cfg } = setup();
  let n = 0;
  const nuke = async (exec) => {
    calls.length = 0;
    for (let i = 0; i < 3; i++) { g.audit = { id: 'e' + ++n, createdTimestamp: Date.now(), executor: { id: exec }, target: { id: 'x' } }; await bot.fire('channelDelete', { guild: g, id: 'd' + n, name: 'c' + i, type: 'GuildText', permissionOverwrites: { cache: new bot.Coll() } }); }
    return calls.includes('ban');
  };
  const base = { sec: { nuke: true, chan: true }, limit: 3, window: 10, punish: 'ban', logCh: 'c1' };
  await cfg({ ...base, on: true });
  assert.equal(await nuke('66'), true, 'punished when ON');
  calls.length = 0;
  await cfg({ ...base, on: true, sec: { nuke: true, chan: false } });
  assert.ok(calls.includes('send:embed'), 'change is reported in the log channel');
  assert.equal(await nuke('67'), false, 'not punished when chan OFF');
  await cfg({ ...base, on: false });
  assert.equal(await nuke('68'), false, 'not punished when master OFF');
});

test('moderation API: warn x3 -> timeout, mute, channel tools, dm on punish', async () => {
  const { bot, calls, cfg } = setup();
  await cfg({ warnMax: 3, warnAct: 'timeout', muteMin: 30, dmPunish: true });
  const h = { headers: { cookie: 'sx=s1' } };
  calls.length = 0;
  for (let i = 0; i < 3; i++) await bot.call('post /api/mod', { ...h, body: { action: 'warn', id: '123456789012345678', reason: 'r' } });
  assert.ok(calls.some((c) => c === 'timeout:1800000'));
  assert.ok(calls.some((c) => c.startsWith('dm:')));
  assert.ok((await bot.call('post /api/chan', { ...h, body: { action: 'lock', channel: 'c1' } })).out.ok);
  assert.ok((await bot.call('post /api/chan', { ...h, body: { action: 'say', channel: 'c1', text: 'hello' } })).out.ok);
  const st = await bot.call('get /api/state', h);
  assert.ok(st.out.acts.length >= 3 && st.out.dlog.length >= 1, 'actions + dashboard log recorded');
});

test('panic reports how many channels were changed', async () => {
  const { bot } = setup();
  const r = await bot.call('post /api/panic', { headers: { cookie: 'sx=s1' }, body: { on: true } });
  assert.equal(r.out.ok, true);
  assert.ok(r.out.done >= 1 && r.out.bad === 0);
});

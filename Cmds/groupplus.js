// CASTRO-MD advanced group protection controls.
const guard = require('../lib/guard');
const { group, num } = guard;

const target = (msg, args) => {
  const c = msg.message?.extendedTextMessage?.contextInfo;
  if (c?.mentionedJid?.length) return c.mentionedJid[0];
  if (c?.participant) return c.participant;
  const n = String(args?.[0] || '').replace(/\D/g, '');
  return n.length >= 7 ? `${n}@s.whatsapp.net` : null;
};
const C = (name, description, run, extra = {}) => ({
  name, description, category: 'group', groupOnly: true, ...extra, run,
});
const A = (name, description, run, extra = {}) =>
  C(name, description, run, { adminOnly: true, ...extra });
const onOff = (v) => (v ? 'ON' : 'OFF');

module.exports = [
  A('guard', 'Show all protection settings for this group', async (ctx) => {
    const g = group(ctx.from);
    await ctx.reply([
      `Antilink: ${onOff(g.antilink.on)} (${g.antilink.mode}, ${g.antilink.all ? 'all links' : 'WhatsApp links'})`,
      `Antispam: ${onOff(g.antispam)}`,
      `Slow mode: ${g.slowmode ? `${g.slowmode}s` : 'OFF'}`,
      `Bad words: ${onOff(g.badwords.on)} (${g.badwords.words.length} words)`,
      `Welcome: ${onOff(g.welcome.on)}`,
      `Goodbye: ${onOff(g.goodbye.on)}`,
      `Banned numbers: ${g.banned.length}`,
      `Exempt members: ${g.permitted.length}`,
      `Silenced members: ${g.silenced.length}`,
      `Warnings before removal: ${g.maxwarns}`,
      `Bot is admin: ${ctx.isBotAdmin ? 'yes' : 'NO'}`,
    ].join('\n'));
  }),

  A('antilink', 'Toggle WhatsApp link protection', async ({ from, args, reply, prefix }) => {
    const g = group(from);
    const value = String(args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(`Use: ${prefix}antilink on|off`);
    g.antilink.on = value === 'on';
    guard.touch();
    await reply(`Antilink protection turned ${value.toUpperCase()}.`);
  }),

  A('antilinkmode', 'Set antilink action: delete, warn or kick', async ({ from, args, reply, prefix }) => {
    const value = String(args[0] || '').toLowerCase();
    if (!['delete', 'warn', 'kick'].includes(value)) return reply(`Use: ${prefix}antilinkmode delete|warn|kick`);
    group(from).antilink.mode = value;
    guard.touch();
    await reply(`Antilink action set to ${value}.`);
  }),

  A('antilinkall', 'Choose WhatsApp links only or all links', async ({ from, args, reply, prefix }) => {
    const value = String(args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(`Use: ${prefix}antilinkall on|off`);
    group(from).antilink.all = value === 'on';
    guard.touch();
    await reply(value === 'on' ? 'All links will be blocked.' : 'Only WhatsApp invite/channel links will be blocked.');
  }),

  A('antispam', 'Toggle anti-spam protection', async ({ from, args, reply, prefix }) => {
    const value = String(args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(`Use: ${prefix}antispam on|off`);
    group(from).antispam = value === 'on';
    guard.touch();
    await reply(`Anti-spam turned ${value.toUpperCase()}.`);
  }),

  A('slowmode', 'Set a per-member message delay in seconds (0 disables)', async ({ from, args, reply, prefix }) => {
    const value = Number(args[0]);
    if (!Number.isInteger(value) || value < 0 || value > 3600) return reply(`Use: ${prefix}slowmode 0-3600`);
    group(from).slowmode = value;
    guard.touch();
    await reply(value ? `Slow mode set to one message every ${value} seconds.` : 'Slow mode disabled.');
  }),

  A('welcome', 'Toggle welcome messages', async ({ from, args, reply, prefix }) => {
    const value = String(args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(`Use: ${prefix}welcome on|off`);
    group(from).welcome.on = value === 'on';
    guard.touch();
    await reply(`Welcome messages turned ${value.toUpperCase()}.`);
  }),

  A('setwelcome', 'Set welcome text; placeholders: {user}, {group}, {count}', async ({ from, text, reply, prefix }) => {
    if (!text) return reply(`Use: ${prefix}setwelcome Welcome {user} to {group}!`);
    if (text.length > 1000) return reply('Welcome text must be 1000 characters or fewer.');
    group(from).welcome.text = text;
    guard.touch();
    await reply('Welcome message saved.');
  }),

  A('goodbye', 'Toggle goodbye messages', async ({ from, args, reply, prefix }) => {
    const value = String(args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(`Use: ${prefix}goodbye on|off`);
    group(from).goodbye.on = value === 'on';
    guard.touch();
    await reply(`Goodbye messages turned ${value.toUpperCase()}.`);
  }),

  A('setgoodbye', 'Set goodbye text; placeholders: {user}, {group}, {count}', async ({ from, text, reply, prefix }) => {
    if (!text) return reply(`Use: ${prefix}setgoodbye Goodbye {user}, see you again!`);
    if (text.length > 1000) return reply('Goodbye text must be 1000 characters or fewer.');
    group(from).goodbye.text = text;
    guard.touch();
    await reply('Goodbye message saved.');
  }),

  A('ban', 'Ban a member from rejoining this group', async ({ sock, msg, from, args, reply, prefix, isBotAdmin }) => {
    const jid = target(msg, args);
    if (!jid) return reply(`Mention/reply to a member or use: ${prefix}ban <number>`);
    const n = num(jid);
    if (group(from).banned.includes(n)) return reply('That member is already on the ban list.');
    group(from).banned.push(n);
    guard.touch();
    const meta = await guard.getMeta(sock, from).catch(() => null);
    if (meta && guard.botIsAdmin(sock, meta)) {
      await sock.groupParticipantsUpdate(from, [jid], 'remove').catch(() => {});
    }
    await reply(`+${n} added to this group's ban list.${isBotAdmin ? ' Rejoin protection is active.' : ' Make the bot an admin to auto-remove banned joiners.'}`);
  }),

  A('unban', 'Remove a number from the group ban list', async ({ msg, from, args, reply, prefix }) => {
    const jid = target(msg, args);
    if (!jid) return reply(`Mention/reply to a member or use: ${prefix}unban <number>`);
    const n = num(jid);
    const g = group(from);
    if (!g.banned.includes(n)) return reply('That number is not on the ban list.');
    g.banned = g.banned.filter((x) => x !== n);
    guard.touch();
    await reply(`+${n} removed from the ban list.`);
  }),

  A('permit', 'Exempt a member from automated group rules', async ({ msg, from, args, reply, prefix }) => {
    const jid = target(msg, args);
    if (!jid) return reply(`Mention/reply to a member or use: ${prefix}permit <number>`);
    const n = num(jid);
    const g = group(from);
    if (!g.permitted.includes(n)) g.permitted.push(n);
    guard.touch();
    await reply(`+${n} is now exempt from automated moderation.`);
  }),

  A('unpermit', 'Remove a member moderation exemption', async ({ msg, from, args, reply, prefix }) => {
    const jid = target(msg, args);
    if (!jid) return reply(`Mention/reply to a member or use: ${prefix}unpermit <number>`);
    const n = num(jid);
    const g = group(from);
    g.permitted = g.permitted.filter((x) => x !== n);
    guard.touch();
    await reply(`+${n} is no longer exempt.`);
  }),

  A('silence', 'Silence a member by deleting their group messages', async ({ msg, from, args, reply, prefix }) => {
    const jid = target(msg, args);
    if (!jid) return reply(`Mention/reply to a member or use: ${prefix}silence <number>`);
    const n = num(jid);
    const g = group(from);
    if (!g.silenced.includes(n)) g.silenced.push(n);
    guard.touch();
    await reply(`+${n} has been silenced by the bot.`);
  }),

  A('unsilence', 'Remove a member from the silence list', async ({ msg, from, args, reply, prefix }) => {
    const jid = target(msg, args);
    if (!jid) return reply(`Mention/reply to a member or use: ${prefix}unsilence <number>`);
    const n = num(jid);
    const g = group(from);
    g.silenced = g.silenced.filter((x) => x !== n);
    guard.touch();
    await reply(`+${n} is no longer silenced.`);
  }),

  A('setmaxwarns', 'Set warnings before automatic removal (2-10)', async ({ from, args, reply, prefix }) => {
    const value = Number(args[0]);
    if (!Number.isInteger(value) || value < 2 || value > 10) return reply(`Use: ${prefix}setmaxwarns 2-10`);
    group(from).maxwarns = value;
    guard.touch();
    await reply(`Maximum warnings set to ${value}.`);
  }),

  A('badwords', 'Toggle bad-word filtering', async ({ from, args, reply, prefix }) => {
    const value = String(args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(`Use: ${prefix}badwords on|off`);
    group(from).badwords.on = value === 'on';
    guard.touch();
    await reply(`Bad-word filtering turned ${value.toUpperCase()}.`);
  }),

  A('addbadword', 'Add a word to this group filter', async ({ from, text, reply, prefix }) => {
    const word = String(text || '').trim().toLowerCase();
    if (!word || word.length > 40 || /\s/.test(word)) return reply(`Use: ${prefix}addbadword <single word>`);
    const g = group(from);
    if (!g.badwords.words.includes(word)) g.badwords.words.push(word);
    guard.touch();
    await reply(`Added "${word}" to the group's filter.`);
  }),

  A('delbadword', 'Remove a word from this group filter', async ({ from, text, reply, prefix }) => {
    const word = String(text || '').trim().toLowerCase();
    if (!word) return reply(`Use: ${prefix}delbadword <word>`);
    const g = group(from);
    g.badwords.words = g.badwords.words.filter((x) => x !== word);
    guard.touch();
    await reply(`Removed "${word}" from the group's filter.`);
  }),

  C('whois', 'Show a member moderation profile', async (ctx) => {
    const jid = target(ctx.msg, ctx.args) || ctx.sender;
    const n = num(jid);
    const g = group(ctx.from);
    const meta = await guard.getMeta(ctx.sock, ctx.from);
    await ctx.sock.sendMessage(ctx.from, {
      text: [
        '*CASTRO-MD MEMBER PROFILE*',
        `Member: @${n}`,
        `Role: ${guard.isAdminNum(meta, n) ? 'admin' : 'member'}`,
        `Messages seen: ${g.stats[n] || 0}`,
        `Warnings: ${g.warns[n] || 0}/${g.maxwarns}`,
        `Exempt: ${g.permitted.includes(n) ? 'yes' : 'no'}`,
        `Silenced: ${g.silenced.includes(n) ? 'yes' : 'no'}`,
        `Banned: ${g.banned.includes(n) ? 'yes' : 'no'}`,
      ].join('\n'),
      mentions: [jid],
    }, { quoted: ctx.msg });
  }, { aliases: ['profile'] }),

  C('ping', 'Check whether CASTRO-MD is responding', async (ctx) => {
    await ctx.reply('Pong! CASTRO-MD is online in this group.');
  }),
];

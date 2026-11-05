const { formatUptime } = require('../lib/utils');
const { box, kv } = require('../lib/table');

const fs = require('fs');
const path = require('path');

// ---------- menu picture ----------
// Order: assets/menu.jpg (or .png/.jpeg) in the project -> MENU_IMAGE link -> the bot's own profile picture.
// The picture is downloaded once and kept in memory, so .menu is instant after the first time.
const ASSET_NAMES = ['menu.jpg', 'menu.jpeg', 'menu.png'];
const MENU_VOICE = path.join(__dirname, '..', 'assets', 'menu-intro.opus');

async function sendMenuVoice(sock, from, opts = {}) {
  try {
    if (!fs.existsSync(MENU_VOICE)) return false;
    const audio = fs.readFileSync(MENU_VOICE);
    if (!audio.length) return false;
    await sock.sendMessage(from, {
      audio,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    }, opts);
    return true;
  } catch (error) {
    console.error('[MENU] Voice intro could not be sent:', error.message);
    return false;
  }
}
let picture = { buf: null, at: 0 };

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 5 * 1024 * 1024) throw new Error('bad image size');
  return buf;
}

async function getPicture(sock, settings) {
  if (picture.buf) return picture.buf;
  if (Date.now() - picture.at < 5 * 60 * 1000) return null; // failed recently: don't retry on every .menu
  picture.at = Date.now();
  for (const name of ASSET_NAMES) {
    const file = path.join(__dirname, '..', 'assets', name);
    if (fs.existsSync(file)) return (picture.buf = fs.readFileSync(file));
  }
  if (settings.menuImage) {
    try {
      return (picture.buf = await fetchBuffer(settings.menuImage));
    } catch {
      // fall through to the profile picture
    }
  }
  try {
    const url = await sock.profilePictureUrl(sock.user.id.replace(/:\d+@/, '@'), 'image');
    if (url) return (picture.buf = await fetchBuffer(url));
  } catch {
    // no profile picture: the menu is sent as text only
  }
  return null;
}

const CATEGORY_ORDER = ['general', 'ai', 'download', 'fun', 'group', 'github', 'owner'];
const CATEGORY_ICON = { general: '🏠', ai: '🤖', download: '📥', fun: '🎉', group: '👥', github: '🐙', owner: '👑' };
const { FOOTER } = require('../lib/brand');
const TIMEZONE = 'Africa/Nairobi';

// One list with every command, grouped by category.
function buildMenu({ commands, prefix, settings, number, channelLink }) {
  const groups = {};
  const seen = new Set();
  for (const c of commands) {
    if (seen.has(c.name)) continue; // the same command name defined twice is listed once
    seen.add(c.name);
    (groups[String(c.category || 'general').toLowerCase()] ||= []).push(c.name);
  }
  const cats = Object.keys(groups).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const total = seen.size;
  const header = box(settings.botName.toUpperCase(), [
    number ? `👋 Hey @${number}` : '👋 Welcome to CASTRO-MD',
    `👤 Owner: ${settings.developer.name}`,
    `⌨️ Prefix: [ ${prefix} ]`,
    `🌍 Mode: ${settings.mode}`,
    `⏱️ Uptime: ${formatUptime(process.uptime())}`,
    `⚙️ Commands: ${total}`,
    `📢 Official Channel: ${channelLink || 'Not configured'}`,
    '━━━━━━━━━━━━━━━━━━━━',
    'Explore commands below and stay connected.'
  ]);
  const sections = cats.map((cat) =>
    box(
      `${CATEGORY_ICON[cat] || '📦'} ${cat.toUpperCase()} (${groups[cat].length})`,
      groups[cat].sort().map((n) => prefix + n)
    )
  );
  return { header, sections, footer: `Need help with one? ${prefix}menu <command>\n\n${FOOTER}` };
}

module.exports = [
  {
    name: 'menu',
    aliases: ['help', 'commands', 'fullmenu', 'allmenu', 'list'],
    description: 'Show every command in one list, with the bot picture',
    run: async ({ sock, msg, from, sender, reply, commands, prefix, settings, channelLink, args }) => {
      // ".menu <command>": what one command does.
      const want = (args[0] || '').toLowerCase().replace(prefix, '');
      if (want && want !== 'all') {
        const c = [...commands].find((x) => x.name === want || (x.aliases || []).includes(want));
        if (!c) return reply(`No command called "${want}".\nType ${prefix}menu to see them all.`);
        return reply(
          kv(c.name.toUpperCase(), [
            ['About', c.description || 'n/a'],
            ['Use', `${prefix}${c.name}`],
            ['Also', (c.aliases || []).map((a) => prefix + a).join(', ') || 'none'],
            ['Who', c.ownerOnly ? 'owner only' : c.adminOnly ? 'group admins' : 'everyone'],
          ])
        );
      }

      const number = String(sender || '').split('@')[0].split(':')[0];
      const { header, sections, footer } = buildMenu({ commands, prefix, settings, number, channelLink });
      const mentions = sender ? [sender] : [];
      const opts = { quoted: msg };

      // The private reply keeps its personal greeting. The one-time Channel
      // source post is generic so a caller's phone number is never published.
      const full = `${header}\n\n${sections.join('\n\n')}\n\n${footer}`;
      const channelMenu = buildMenu({ commands, prefix, settings, number: '', channelLink });
      const channelFull = `${channelMenu.header}\n\n${channelMenu.sections.join('\n\n')}\n\n${channelMenu.footer}`;
      const img = await getPicture(sock, settings).catch(() => null);

      try {
        // Forward only a real message fetched back from the official Channel.
        // The helper requires persistent storage and otherwise leaves the
        // established direct-menu behavior untouched.
        const nativeForwarded = await require('../lib/channelMenuForward').forwardMenu({
          sock, from, channelLink, image: img, caption: channelFull, settings,
        });
        if (nativeForwarded) {
          await sendMenuVoice(sock, from);
          return;
        }
        // No picture available: one plain text message with the whole list.
        if (!img) {
          await sock.sendMessage(from, { text: full, mentions }, opts);
          await sendMenuVoice(sock, from);
          return;
        }
        if (full.length <= 3500) {
          await sock.sendMessage(from, { image: img, caption: full, mentions }, opts);
          await sendMenuVoice(sock, from);
          return;
        }
        await sock.sendMessage(from, { image: img, caption: header, mentions }, opts);
        // Plain text in chunks below WhatsApp's comfortable size, never splitting a category box.
        let chunk = '';
        for (const sec of [...sections, footer]) {
          if (chunk && chunk.length + sec.length > 3000) {
            await sock.sendMessage(from, { text: chunk });
            chunk = '';
          }
          chunk += (chunk ? '\n\n' : '') + sec;
        }
        if (chunk) await sock.sendMessage(from, { text: chunk });
        await sendMenuVoice(sock, from);
      } catch (e) {
        await reply(full); // picture failed: still send the full menu as text
        await sendMenuVoice(sock, from);
      }
    },
  },
  {
    name: 'ping',
    aliases: ['speed'],
    description: 'Check response speed',
    run: async ({ sock, from, msg, reply }) => {
      const t = Date.now();
      const sent = await reply('Pinging...');
      const ms = Date.now() - t;
      try {
        await sock.sendMessage(from, { text: `*Pong! ${ms}ms*`, edit: sent.key });
      } catch {
        await reply(`Pong! ${ms}ms`);
      }
    },
  },
  {
    name: 'alive',
    aliases: ['status'],
    description: 'Check the bot is running',
    run: async ({ reply, settings }) =>
      reply(`*${settings.botName}* is online.\nUptime: ${formatUptime(process.uptime())}`),
  },
  {
    name: 'say',
    aliases: ['echo'],
    description: 'Repeat your text',
    run: async ({ reply, text, prefix }) => reply(text || `Usage: ${prefix}say <text>`),
  },

  // ---- New general commands ----
  {
    name: 'channel',
    aliases: ['support'],
    description: 'Get the bot channel link',
    run: async ({ reply, channelLink }) => reply(channelLink ? `Follow our channel:\n${channelLink}` : 'The official CASTRO-MD channel has not been configured yet.'),
  },
  {
    name: 'uptime',
    aliases: ['runtime'],
    description: 'Show how long the bot has been running',
    run: async ({ reply }) => reply(`Uptime: ${formatUptime(process.uptime())}`),
  },
  {
    name: 'time',
    description: 'Show the current time',
    run: async ({ reply, settings }) => {
      const tz = settings.timezone || TIMEZONE;
      const now = new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
      await reply(`Time: ${now} (${tz})`);
    },
  },
  {
    name: 'date',
    aliases: ['today'],
    description: 'Show today\'s date',
    run: async ({ reply, settings }) => {
      const tz = settings.timezone || TIMEZONE;
      const d = new Date().toLocaleDateString('en-GB', {
        timeZone: tz,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      await reply(`Date: ${d}`);
    },
  },
  {
    name: 'botinfo',
    aliases: ['info', 'about'],
    description: 'Show information about the bot',
    run: async ({ reply, commands, prefix, settings }) =>
      reply(
        kv(settings.botName.toUpperCase(), [
          ['Prefix', prefix],
          ['Mode', settings.mode],
          ['Commands', commands.size],
          ['Uptime', formatUptime(process.uptime())],
          ['Node', process.version],
          ['Memory', `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`],
        ])
      ),
  },
  {
    name: 'prefix',
    description: 'Show the current command prefix',
    run: async ({ reply, prefix }) => reply(`Current prefix: [ ${prefix} ]`),
  },
  {
    name: 'jid',
    aliases: ['chatid'],
    description: 'Show the ID of this chat',
    run: async ({ reply, from }) => reply(`Chat ID: ${from}`),
  },
  {
    name: 'calc',
    aliases: ['calculate'],
    description: 'Do a quick calculation',
    run: async ({ reply, text, prefix }) => {
      const expr = (text || '').trim();
      if (!expr) return reply(`Usage: ${prefix}calc 12*(3+4)`);
      // Allow only digits, spaces and basic math characters.
      if (expr.length > 100 || !/^[\d\s+\-*/%().^]+$/.test(expr)) {
        return reply('Only numbers and + - * / % ^ ( ) are allowed.');
      }
      try {
        const result = Function(`"use strict"; return (${expr.replace(/\^/g, '**')});`)();
        if (typeof result !== 'number' || !Number.isFinite(result)) {
          return reply('That does not give a valid number.');
        }
        await reply(`${expr} = ${result}`);
      } catch {
        await reply('Invalid expression.');
      }
    },
  },
];
                            

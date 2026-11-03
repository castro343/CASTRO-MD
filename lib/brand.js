// CASTRO-MD branding used at the bottom of bot replies.
const TEXT = 'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀsᴛʀᴏ';

const FOOTER = `> ${TEXT}`;
const hasFooter = (t) => String(t).includes(TEXT);

module.exports = { FOOTER, hasFooter };

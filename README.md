<div align="center">

# CASTRO-MD

**A modular WhatsApp automation bot built with Baileys.**

*sema.walai.nimejaa.ngori 😶‍🌫️*

![CASTRO-MD WhatsApp Bot](https://user52126.na.imgto.link/public/20261105/0f20c6dde9f569aeadb696a5-712532.avif)

[Repository](https://github.com/castro343/CASTRO-MD) · [Issues](https://github.com/castro343/CASTRO-MD/issues)

</div>

---

## Features

- WhatsApp pairing-code and QR login
- Session ID export and restoration
- Modular command handler
- Public and private operating modes (public users share the one connected bot account)
- Group protection hooks
- Status auto-view, auto-read, incoming-call rejection, always-online, and owner-only anti-delete text alerts
- Optional MongoDB-backed session persistence
- Lightweight HTTP health and pairing server

## Requirements

- Node.js 20
- A WhatsApp account
- Optional MongoDB connection string for persistent sessions

## Configuration

For local use, copy `set.env.example` to `set.env` and fill in your private values. On Render, add the same values in the service environment settings. Do not commit `set.env`.

| Variable | Description | Default |
| --- | --- | --- |
| `BOT_NAME` | Bot display name | `CASTRO-MD` |
| `OWNER_NUMBER` | Additional owner numbers, comma-separated, country code included | — |
| `PREFIX` | Command prefix | `.` |
| `MODE` | `public` or `private` | `public` |
| `PAIRING_NUMBER` | Number used for pairing-code login, digits only | — |
| `SESSION_ID` | Previously generated CASTRO-MD session ID | — |
| `MONGODB_URI` | Optional MongoDB connection URI | — |
| `MONGODB_DB` | MongoDB database name | `castro_md` |
| `AUTO_VIEW_STATUS` | Automatically view status updates | `true` |
| `AUTO_READ` | Automatically mark incoming messages as read | `false` |
| `ANTI_CALL` | Automatically reject incoming WhatsApp calls | `false` |
| `ANTI_DELETE` | Enable owner alerts for deleted incoming text messages | `false` |
| `ALWAYS_ONLINE` | Keep WhatsApp presence marked online while connected | `false` |
| `TIMEZONE` | Time zone for connection alerts | `Africa/Nairobi` |

The primary owner is configured as Castro. The default owner number is set in `settings.js`; additional owners can be supplied with `OWNER_NUMBER`.

## Run

```bash
npm install
npm start
```

Open `/pair` on the running service to use the pairing page. You can also configure `PAIRING_NUMBER` to request a pairing code on startup. After linking, the bot sends a session ID to the linked WhatsApp account. Keep that ID private.

Send `.menu` in WhatsApp to check the command menu. After linking, bot controls are WhatsApp commands (not a separate dashboard): `.autoviewstatus on|off`, `.autoread on|off`, `.anticall on|off`, `.antidelete on|off`, and `.alwaysonline on|off` are owner-only settings. Anti-delete reports cached text to the configured owner; it does not recover or forward media. Group admins can use `.guard` and the group protection commands inside their groups.

## WhatsApp account model

CASTRO-MD runs **one main WhatsApp session per deployment**. Public mode lets other people send commands to that connected account, subject to the bot's permissions and group rules. It does **not** let each user independently link a separate WhatsApp account to the same running bot. This single-session design is intentional: it keeps authentication, message handling, moderation state, and hosting simpler and avoids the reliability risks of managing several linked accounts in one process.

If you deploy another independent copy, give it its own WhatsApp account, session storage, and hosting service. Do not point two running copies at the same session.

## Session storage

MongoDB is optional. If `MONGODB_URI` is configured, CASTRO-MD stores the WhatsApp credentials and encryption keys in MongoDB to survive restarts and redeployments. Without it, Baileys uses the local `session` directory.

New session IDs use the `CASTRO-MD~` prefix. Existing `NEXUS~` session IDs remain supported for migration.

## Deployment

The repository includes a `render.yaml` blueprint. Add your private `SESSION_ID` and optional `MONGODB_URI` in Render's environment settings before deploying.

---

<div align="center">

**CASTRO-MD**  
*Powered by Castro*

</div>

# dsh-channel-telegram

Cordis Host composition plugin for DSH versions from 0.1.0-rc.8 up to, but not including, 0.2.0.

## Install

The QQ-enabled plugin is the 0.3.0 release line. Publish npm packages in dependency order: `@wsxcant/dsh-channel-telegram-gateway@0.2.2`, `@wsxcant/dsh-channel-qq@0.1.0`, then `dsh-channel-telegram@0.3.0`, before installing this package from the registry:

    dsh plugin --profile web add dsh-channel-telegram@0.3.0

For source-checkout verification, link the profile dependency to this package and rebuild the workspace. The DSH plugin manager installs a published package and adds its bundled composition patch to the profile. Restart the active DSH Web Host, then configure Telegram and QQ under Settings > Plugins.

Example composition row:

    - name: dsh-channel-telegram
      config:
        allowedUserIds: []
        hostName: Local DSH
        turnTimeoutMs: 600000
        progressEditIntervalMs: 1000
        diagnosticLogging: false
        qqAppId: ""
        qqAllowedOpenIds: []
        qqProgressIntervalMs: 3000
        qqOpenIdLookupEnabled: false

## Web settings

Open DSH Settings and select Plugins. The Telegram card manages:

- Bot Token, stored only by DSH Credentials under the fixed reference
  `TELEGRAM_BOT_TOKEN`. The browser can read configured/source/writable status,
  but the stored value is never returned or rendered.
- Allowed Telegram user IDs, stored in the Host `telegram` settings namespace.
  IDs must be unique positive safe integers.
- Current host name, stored in the same namespace. It is trimmed, limited to 64
  characters, and shown in the Telegram Computers menu. The computer ID remains
  `local`.

The composition values are defaults for host name and user IDs. Saved Web
settings override those defaults and survive profile reload. Credential and settings
updates serialize a Telegram runtime restart. With no Bot
Token or no allowed user ID, Telegram remains available for configuration but does not
poll.

## QQ C2C

The QQ card manages a QQ Official Bot API v2 C2C channel. It stores AppID,
allowed QQ user OpenIDs, and stage-message interval in the Host `qq` namespace.
AppID is limited to 64 characters; OpenIDs are trimmed, deduplicated, and limited
to 128 characters; the stage interval is an integer from 1000 to 60000 ms.
The AppSecret is write-only DSH Credentials under `QQ_BOT_APP_SECRET`; its
stored value is never returned to the browser. The QQ runtime does not start until
AppID, AppSecret, and at least one allowed OpenID are present. A normal QQ number is
not a user OpenID. To bootstrap the allowlist, temporarily enable `Allow /openid
identity lookup`, send `/openid` in C2C, save the returned value as an allowed
OpenID, and disable the lookup again. While enabled, only `/openid` replies before
authorization; it never invokes DSH.

QQ v1 is C2C only. It obtains and refreshes access tokens server-side, uses the
official Gateway with the `GROUP_AND_C2C_EVENT` intent, resumes processed event
sequences after reconnect, and de-duplicates C2C events by message ID plus
message index. Text commands and numbered menus are always available; inline QQ
keyboards are not required. The `C2C_MESSAGE_CREATE` OpenID must appear in the
allowlist before any DSH action is performed. QQ C2C input uses `msg_type: 6`. Unlike
Telegram, QQ does not continuously edit one progress message: current-stage progress
is sent as separate text messages throttled by `qqProgressIntervalMs`, and the final
result is sent as another message. QQ emits only the turn process node; tool names,
tool results, and repeated `Working...` notices are omitted. This is an expected
Telegram/QQ transport difference.

Never place either bot secret in composition configuration, repository files, logs, or
normal settings. Telegram uses `TELEGRAM_BOT_TOKEN`; QQ uses
`QQ_BOT_APP_SECRET`. Only one running plugin instance may own the configured bot
credentials.

Use /start or /menu in Telegram, or send /start or /menu in QQ C2C, to select the computer, project,
and session. Telegram uses inline buttons; QQ C2C uses the numbered menu shown in its reply. `/new` opens the available Agent preset
menu and creates the session only after a preset is selected.

Telegram and QQ runtimes restart independently when their settings or credential
changes are saved, and both stop their subscriptions and transports on dispose.

Once a session is selected, the bot relays that session's running turns even
when they were started from the DSH GUI or another client. Switching computer,
project, or session immediately removes the previous subscription. A Telegram
message still uses exact message/turn correlation for its direct progress, while
the selected-session relay is suppressed for that originating chat to avoid a
duplicate. Other chats selecting the same session continue to receive it.

The Telegram bot edits one progress message at the configured interval and finalizes it
with the turn result. QQ uses the separate stage-message behavior described above. Only visible assistant text and tool names/status are
forwarded; reasoning, tool arguments, tool result bodies, and internal error
details are not forwarded.

Set diagnosticLogging to true only while troubleshooting inbound delivery. It
sends one readiness notice to each allowlisted user and logs update kind plus
numeric routing metadata, but never message text, callback data, credentials,
project ids, or session ids.

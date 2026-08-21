# dsh-channel-telegram

Cordis Host composition plugin for DSH versions from 0.1.0-rc.8 up to, but not including, 0.2.0.

## Install

    dsh plugin --profile web add dsh-channel-telegram@0.2.1

The DSH plugin manager installs the npm package and adds its bundled composition
patch to the profile. Restart the active DSH Web Host, then configure Telegram
under Settings > Plugins.

Example composition row:

    - name: dsh-channel-telegram
      config:
        allowedUserIds: []
        hostName: Local DSH
        turnTimeoutMs: 600000
        progressEditIntervalMs: 1000
        diagnosticLogging: false

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
settings override those defaults and survive profile reload. Settings and
credential updates serialize a poller restart. With no Bot Token or no allowed
user ID, the plugin remains available for configuration but does not poll
Telegram.

Never place the Bot Token in composition configuration, repository files, logs,
or normal settings. Only one running plugin instance may own a Bot Token.

Use /start or /menu in the private bot chat to select the computer, project,
and session through inline buttons. `/new` opens the available Agent preset
menu and creates the session only after a preset is selected.

Once a session is selected, the bot relays that session's running turns even
when they were started from the DSH GUI or another client. Switching computer,
project, or session immediately removes the previous subscription. A Telegram
message still uses exact message/turn correlation for its direct progress, while
the selected-session relay is suppressed for that originating chat to avoid a
duplicate. Other chats selecting the same session continue to receive it.

The bot edits one progress message at the configured interval and finalizes it
with the turn result. Only visible assistant text and tool names/status are
forwarded; reasoning, tool arguments, tool result bodies, and internal error
details are not forwarded.

Set diagnosticLogging to true only while troubleshooting inbound delivery. It
sends one readiness notice to each allowlisted user and logs update kind plus
numeric routing metadata, but never message text, callback data, credentials,
project ids, or session ids.

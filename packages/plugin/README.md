# dsh-channel-telegram

Cordis Host composition plugin pinned to DSH 0.1.0-rc.8.

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
and session through inline buttons. The bot edits one progress message at the
configured interval and finalizes it with the correlated turn result. Only text
and tool names from the exact submitted DSH turn are surfaced; reasoning, tool
arguments, and tool result bodies are not forwarded.

Set diagnosticLogging to true only while troubleshooting inbound delivery. It
sends one readiness notice to each allowlisted user and logs update kind plus
numeric routing metadata, but never message text, callback data, credentials,
project ids, or session ids.

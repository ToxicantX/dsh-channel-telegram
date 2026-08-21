# dsh-channel-telegram

Cordis Host composition plugin pinned to DSH 0.1.0-rc.8.

Example composition row:

    - name: dsh-channel-telegram
      config:
        tokenRef: TELEGRAM_BOT_TOKEN
        allowedUserIds: [123456789]
        turnTimeoutMs: 600000
        progressEditIntervalMs: 1000

The token value is resolved through ctx.credentials. Never place the token in
this configuration. Only one running plugin instance may own a Bot Token.

Use /menu in the private bot chat to select the computer, project, and session
through inline buttons. The bot edits one progress message at the configured
interval and finalizes it with the correlated turn result. Only text and tool
names from the exact submitted DSH turn are surfaced; reasoning, tool arguments,
and tool result bodies are not forwarded.

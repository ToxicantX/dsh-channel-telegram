# dsh-channel-telegram

Cordis Host composition plugin pinned to DSH 0.1.0-rc.8.

Example composition row:

    - name: dsh-channel-telegram
      config:
        tokenRef: TELEGRAM_BOT_TOKEN
        allowedUserIds: [123456789]
        turnTimeoutMs: 600000

The token value is resolved through ctx.credentials. Never place the token in
this configuration. Only one running plugin instance may own a Bot Token.

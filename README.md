# DSH Channel Telegram

Host composition and channel packages for the 0.3.0 release, targeting DeepSeek Harness from 0.1.0-rc.8 up to, but not including, 0.2.0.
The plugin provides independent Telegram and QQ Official Bot C2C runtimes over one
shared DSH control plane.

## Packages

- @wsxcant/dsh-channel-telegram-protocol: versioned Gateway/Node messages.
- @wsxcant/dsh-channel-telegram-gateway: authenticated menus, turn progress, routing, and session relay.
- @wsxcant/dsh-channel-qq: QQ Official Bot API v2 C2C transport and numbered command channel.
- dsh-channel-telegram: DSH Host adapter, Telegram gateway, QQ channel, and Cordis plugin.

## Host Plugin and 0.3.0 Release

The QQ-enabled release publishes npm packages in dependency order: `@wsxcant/dsh-channel-telegram-gateway@0.2.2`, `@wsxcant/dsh-channel-qq@0.1.0`, then `dsh-channel-telegram@0.3.0`. Use the registry install command only after those packages are published:

    dsh plugin --profile web add dsh-channel-telegram@0.3.0

For source-checkout verification, link the profile dependency to packages/plugin and rebuild the workspace before refreshing the active DSH Web Host. Configure both channel cards under Settings > Plugins. Telegram stores its allowlist
and host name in the `telegram` namespace and uses the write-only credential ref
`TELEGRAM_BOT_TOKEN`. QQ stores AppID, allowed OpenIDs, and stage-message interval
in the `qq` namespace and uses the write-only credential ref
`QQ_BOT_APP_SECRET`. The default-off `/openid` identity lookup can be enabled temporarily to obtain the sender's event OpenID; it must be disabled again after the allowlist is configured.

Each runtime starts only when its own credentials and allowlist are usable. Settings
or credential changes restart Telegram and QQ independently; disposal stops both
transports and session subscriptions. Secrets never belong in composition config,
repository files, logs, or ordinary settings values.

Telegram accepts private-chat updates from its numeric allowlist. QQ accepts C2C
messages only when the sender OpenID is in its string allowlist. QQ C2C input uses
`msg_type: 6`. Unlike Telegram, QQ does not continuously edit one progress message:
current-stage progress is sent as separate text messages throttled by
`qqProgressIntervalMs`, and the final result is sent as another message. QQ emits only the turn process node; tool names, tool results, and repeated `Working...` notices are omitted. This is an
expected Telegram/QQ transport difference. Both channels expose text commands,
session selection, Agent preset creation, stop, and selected-session progress relay
through the shared control plane.

## Development

Run `pnpm install` followed by `pnpm check`. Tests do not start Telegram long polling
or require live bot credentials. QQ transport tests use fake HTTP and Gateway peers.

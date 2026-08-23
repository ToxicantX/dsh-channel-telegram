# DSH Channel Telegram

Host composition and channel packages. The 0.4.0 Telegram/QQ/WeChat release targets DeepSeek Harness from 0.1.0-rc.8; the WeChat Web QR control requires DSH client connection 0.1.1-rc.1 or newer.
The plugin provides independent Telegram, QQ Official Bot C2C, and experimental
WeChat iLink private-chat runtimes over one shared DSH control plane.

## Packages

- @wsxcant/dsh-channel-telegram-protocol: versioned Gateway/Node messages.
- @wsxcant/dsh-channel-telegram-gateway: authenticated menus, turn progress, routing, and session relay.
- @wsxcant/dsh-channel-qq: QQ Official Bot API v2 C2C transport and numbered command channel.
- @wsxcant/dsh-channel-wechat: experimental WeChat iLink private-chat transport adapted from Tencent's `@tencent-weixin/openclaw-weixin@2.4.6` transport.
- dsh-channel-telegram: DSH Host adapter, Telegram gateway, QQ channel, and Cordis plugin.

## Host Plugin and 0.4.0 Release

Publish npm packages in dependency order: `@wsxcant/dsh-channel-telegram-gateway@0.3.0`, `@wsxcant/dsh-channel-qq@0.2.0`, `@wsxcant/dsh-channel-wechat@0.1.0`, then `dsh-channel-telegram@0.4.0`. Use the registry install command only after those packages are published:

    dsh plugin --profile web add dsh-channel-telegram@0.4.0

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

Telegram and QQ show the shared target menus in Chinese. QQ prefers native C2C buttons and automatically falls back to numbered text when a keyboard is unavailable.

## Experimental WeChat Channel

The 0.4.0 release includes the experimental WeChat transport and its Web QR settings card.

WeChat V1 supports Web QR login, write-only credential-provider storage, restart recovery, private text messages, allowlisted iLink users, numbered menus, typing status, one process node, final replies, and selected-session relay. Its transport ports Tencent v2.4.6 QR login, iLink API headers and payloads, `notifyStart`/`notifyStop`, `getUpdates`, cursor persistence, session guard, and config cache while retaining DSH routing and access control. Group chat, button menus, media forwarding, OpenClaw pairing, bindings, and Agent routing are outside V1.

QR login, restart recovery, private inbound messages, and replies were verified against a real desktop account. Tencent/openclaw-weixin issue #244 remains relevant when an account stays online while `getUpdates` returns an empty `msgs` array. Credentials, cursor, context tokens, typing tickets, raw QR URLs, and verification codes are never stored in ordinary settings or rendered as plain values.

## Development

Run `pnpm install` followed by `pnpm check`. Tests do not start Telegram long polling
or require live bot credentials. QQ transport tests use fake HTTP and Gateway peers.

# DSH Channel Telegram

Telegram control plane for DeepSeek Harness. The first milestone is a single
Gateway running as a DSH Host composition plugin. A later milestone adds
outbound WSS nodes without introducing a second Telegram Bot poller.

## Packages

- @dsh-channel-telegram/protocol: versioned Gateway/Node messages.
- @dsh-channel-telegram/gateway: authenticated Telegram command and routing core.
- dsh-channel-telegram: DSH 0.1.0-rc.8 Host adapter and Cordis plugin.

## Development

Run pnpm install followed by pnpm check. Tests never start Telegram long
polling and require no Bot Token.

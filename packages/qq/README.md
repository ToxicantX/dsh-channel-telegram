# @wsxcant/dsh-channel-qq

QQ official Bot API v2 C2C transport used by dsh-channel-telegram. It provides access-token refresh, Gateway identify/resume/heartbeat/reconnect, allowlisted C2C commands, native inline keyboards with numbered-text fallback, progress replies, and bounded event de-duplication.

Unauthorized messages are ignored by default. Hosts may temporarily set `identityLookupEnabled` so an unauthorized sender can use `/openid` to receive only their own event OpenID; no other unauthorized command reaches the DSH control plane.

## Delivery behavior

Shared target menus are shown in Chinese. Native button callbacks subscribe to `INTERACTION_CREATE`, are acknowledged immediately, and continue through the same actor-bound opaque callback tokens as the text fallback.

QQ C2C input uses `msg_type: 6`. Unlike Telegram, QQ does not continuously edit one progress message. Current-stage progress is sent as separate text messages throttled by the host setting `qqProgressIntervalMs`, and the final result is sent as another message. QQ emits only the turn process node; tool names, tool results, and repeated `Working...` notices are omitted. This is an expected Telegram/QQ transport difference.

## 0.4.0 Release

Publish npm packages in dependency order: `@wsxcant/dsh-channel-telegram-gateway@0.3.0`, `@wsxcant/dsh-channel-qq@0.2.0`, `@wsxcant/dsh-channel-wechat@0.1.0`, then `dsh-channel-telegram@0.4.0`.

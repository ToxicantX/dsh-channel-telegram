# DSH Channel Telegram

[English](README.md) | [简体中文](README.zh-CN.md)

`dsh-channel-telegram` connects a DeepSeek Harness Host to Telegram private chats, QQ Official Bot C2C messages, and WeChat iLink private chats. All three channels share the same authenticated DSH control plane for host, project, and session selection.

Version `0.4.0` includes:

- Telegram inline menus and progress-message editing.
- QQ native C2C keyboards, interaction callbacks, and a numbered-text fallback.
- A DSH-native WeChat transport adapted from Tencent's MIT-licensed `@tencent-weixin/openclaw-weixin@2.4.6` transport.
- Chinese progressive menus: downstream choices appear only after their parent target has been selected.
- A dedicated **Status** action that shows the selected host, project, session, and session state.

## Requirements

- Node.js 22 or newer.
- DeepSeek Harness `0.1.1-rc.1` or newer is recommended. The WeChat Web QR control requires `@deepseek-ai/dsh-client-connection >=0.1.1-rc.1`.
- One or more channel accounts:
  - Telegram Bot Token.
  - QQ Official Bot AppID and AppSecret.
  - A WeChat account that can complete the iLink QR authorization flow.

## Install or upgrade

Install the published Host plugin into the `web` profile:

```bash
dsh plugin --profile web add dsh-channel-telegram@0.4.0
```

Restart the active DSH Web Host or the desktop application after installation. Open **Settings → Plugins** to configure each channel. To upgrade, install the desired pinned version with the same command, restart DSH, and confirm the installed version in the plugin list. Credentials remain in DSH credential storage instead of the repository or composition file.

Published packages:

| Package | Version | Purpose |
| --- | --- | --- |
| `dsh-channel-telegram` | `0.4.0` | DSH Host plugin and Web settings cards |
| `@wsxcant/dsh-channel-telegram-gateway` | `0.3.0` | Shared menus, routing, and session relay |
| `@wsxcant/dsh-channel-qq` | `0.2.0` | QQ Official Bot C2C transport |
| `@wsxcant/dsh-channel-wechat` | `0.1.0` | WeChat iLink private-chat transport |

## Configure in DSH Web

The screenshots below were captured from the real DSH settings UI. Account IDs were replaced with example values, and secret fields remain blank.

### Telegram

![Telegram settings with sanitized example values](docs/images/telegram-settings.png)

1. Create a bot with BotFather and copy its Bot Token.
2. Add the numeric Telegram user IDs that may control DSH.
3. Set the host name displayed in the target menu.
4. Paste the Bot Token and select **Save**.

Telegram starts only when both a Bot Token and at least one allowed user ID are configured. The token is stored through the write-only DSH credential reference `TELEGRAM_BOT_TOKEN`; it is never returned to the browser after saving.

### QQ Official Bot

![QQ settings with sanitized example values](docs/images/qq-settings.png)

1. Create or select a QQ Official Bot and copy its AppID and AppSecret.
2. Enter the AppID and AppSecret in the QQ card.
3. If the sender OpenID is unknown, temporarily enable **Allow `/openid` identity lookup**.
4. Send `/openid` to the bot in a C2C conversation.
5. Add the returned event OpenID to **Allowed QQ user OpenIDs**.
6. Disable identity lookup again and save.

A normal QQ number is not an OpenID. QQ starts only when AppID, AppSecret, and at least one allowed OpenID are available. The AppSecret is stored through `QQ_BOT_APP_SECRET`. The progress interval accepts `1000`–`60000` ms.

QQ prefers native C2C buttons. If the QQ API rejects a keyboard, the channel automatically sends the same menu as numbered text.

### WeChat iLink

![WeChat settings with sanitized example values](docs/images/wechat-settings.png)

1. Expand the WeChat card and start QR login.
2. Scan and confirm on the WeChat client; wait for the card to show **Online**.
3. If the iLink user ID is unknown, temporarily enable **Allow `/userid` identity lookup**.
4. Send `/userid` in the private chat.
5. Add the returned ID to **Allowed WeChat iLink user IDs**.
6. Disable identity lookup and save.

QR credentials, cursor, context tokens, and typing state are serialized under the fixed write-only DSH credential reference `DSH_CHANNEL_TELEGRAM_WECHAT_ILINK`. Raw QR URLs, verification codes, and tokens are not stored in ordinary settings or rendered as plain values.

WeChat currently uses numbered text menus because iLink private chats do not expose the QQ-style native keyboard used by this plugin. Group chats and media forwarding are outside the current V1 scope.

## Composition defaults

Web settings are the recommended configuration path. The bundled composition patch supplies these non-secret defaults:

```yaml
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
    wechatAllowedUserIds: []
    wechatIdentityLookupEnabled: false
```

| Setting | Meaning |
| --- | --- |
| `allowedUserIds` | Numeric Telegram allowlist |
| `hostName` | Host label shown in all channel menus |
| `turnTimeoutMs` | Maximum DSH turn duration |
| `progressEditIntervalMs` | Telegram progress edit throttle |
| `diagnosticLogging` | Temporary metadata-only Telegram diagnostics |
| `qqAppId` | QQ Official Bot AppID |
| `qqAllowedOpenIds` | QQ C2C sender OpenID allowlist |
| `qqProgressIntervalMs` | QQ stage-message throttle, `1000`–`60000` ms |
| `qqOpenIdLookupEnabled` | Allows unauthorized `/openid` lookup only |
| `wechatAllowedUserIds` | WeChat iLink user ID allowlist |
| `wechatIdentityLookupEnabled` | Allows unauthorized `/userid` lookup only |

Do not put Telegram Bot Tokens, QQ AppSecrets, WeChat credentials, raw QR URLs, or verification codes in this YAML.

## Use the shared menu

Send `/start` or `/menu` in a supported private/C2C chat.

The menu reveals actions progressively:

| Current selection | Available actions |
| --- | --- |
| No host | `主机`, `状态`, `刷新` |
| Host selected | Adds `项目` |
| Project selected | Adds `会话` and `新建会话` |

Select an Agent preset after choosing `新建会话`. The `状态` view shows the current host, project, session, and session state, with `返回` and `刷新` actions.

Text commands remain available:

```text
/start       open the menu
/menu        open the menu
/computers   select a host (legacy command name retained for compatibility)
/projects    select a project
/sessions    select a session
/new         create a session from an Agent preset
/status      show the current selection and state
/stop        stop the live turn while preserving queued work
```

## Channel behavior

| Capability | Telegram | QQ | WeChat |
| --- | --- | --- | --- |
| Private/C2C text | Yes | Yes | Yes |
| Native buttons | Inline keyboard | C2C keyboard | No; numbered text |
| Numbered fallback | Yes | Yes | Yes |
| Allowlist | Numeric user ID | Event OpenID | iLink user ID |
| Identity bootstrap | External numeric ID | `/openid` | `/userid` |
| Progress | Edited message | Throttled stage messages | Typing + one process node |
| Selected-session relay | Yes | Yes | Yes |

Only allowlisted users reach the DSH control plane. Callback tokens are opaque, actor-bound, conversation-bound, single-use, and expire automatically.

## Troubleshooting

- **Channel stays disabled:** verify both the channel credential and a non-empty allowlist.
- **QQ shows numbered text:** the native keyboard request was rejected; the fallback remains fully usable.
- **QQ buttons do not react:** confirm the bot receives `INTERACTION_CREATE` and C2C message intents, then send a fresh `/menu` because callback tokens are single-use.
- **WeChat is Online but receives nothing:** re-login and retry a private text message. Tencent has also documented accounts that return HTTP 200 with an empty `msgs` array in [openclaw-weixin issue #244](https://github.com/Tencent/openclaw-weixin/issues/244).
- **Menu expired:** send `/menu` again.
- **Wrong target is selected:** open `状态`, then reselect the host, project, and session in order.

Enable `diagnosticLogging` only during troubleshooting. It logs routing metadata but not message text, callback data, credentials, project IDs, or session IDs.

## Development

```bash
pnpm install
pnpm check
```

`pnpm check` builds, type-checks, and tests all workspace packages. Tests use fake Telegram, QQ, WeChat, HTTP, and Gateway peers; live account validation remains a separate acceptance step.

## Security and scope

- Never commit `.env`, `.npmrc`, access tokens, Bot Tokens, AppSecrets, QR payloads, verification codes, OpenIDs, or iLink user IDs.
- Configure only one running plugin instance for a given set of bot credentials.
- Telegram and QQ credentials are write-only; WeChat session material is stored as one write-only credential record.
- The WeChat transport retains Tencent's MIT notice in [`packages/wechat/LICENSE.tencent-openclaw-weixin`](packages/wechat/LICENSE.tencent-openclaw-weixin).

## License

The workspace packages declare the MIT license. The Tencent-derived WeChat transport also retains the upstream adaptation notice linked above.

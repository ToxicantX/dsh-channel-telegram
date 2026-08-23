# @wsxcant/dsh-channel-wechat

Experimental WeChat iLink Bot private-chat transport for dsh-channel-telegram.

V1 supports QR-authorized iLink accounts, private text messages, allowlisted users, numbered DSH menus, typing status, one turn-start process node, final replies, and selected-session relay. Group chat, button menus, and media forwarding are outside V1.

The transport is a DSH-native adaptation of the QR login, iLink API,
`getUpdates` monitor, session guard, config cache, lifecycle notifications, and
cursor handling from Tencent's `@tencent-weixin/openclaw-weixin@2.4.6`.
OpenClaw plugin SDK, pairing, bindings, Agent routing, and OpenClaw account
storage are intentionally excluded. Credentials must be stored by the Host and
must not be committed or rendered in the browser.

The adapted Tencent code is MIT licensed. See
`LICENSE.tencent-openclaw-weixin` for its copyright and license notice.

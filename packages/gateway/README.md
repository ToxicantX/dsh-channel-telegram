# Telegram Gateway

The core accepts normalized private Telegram text updates and talks only to a
DshPort. It owns authorization, selections, bounded update idempotency, and a
per-session FIFO. It issues short-lived, opaque, single-use callback tokens for
paginated computer, project, and session menus. Callback tokens are bound to the
allowed private user and chat, and stale hierarchy selections are rejected.

Turn progress is correlated to the exact submitted DSH user message and turn.
Telegram delivery coalesces edits to one progress message, lists tool names but
not arguments or result bodies, and splits final text at the 4096-character API
limit. Telegram long polling is started only by the Host plugin.

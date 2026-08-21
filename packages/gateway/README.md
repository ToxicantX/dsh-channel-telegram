# Telegram Gateway

The core accepts normalized private Telegram text updates and talks only to a
DshPort. It owns authorization, selections, bounded update idempotency, and a
per-session FIFO. Telegram long polling is started only by the Host plugin.

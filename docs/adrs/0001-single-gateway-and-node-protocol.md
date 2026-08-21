# ADR 0001: Single Telegram Gateway and Outbound DSH Nodes

Status: Accepted for MVP

## Context

One Telegram Bot Token must have one long-polling owner. DSH 0.1.0-rc.8
already exposes workspace, persistent session, live agent, event, credential,
approval, and user-question services. The unstable RC surface must not leak
through the Telegram command layer.

## Decision

The MVP is one Host composition plugin on a persistent DSH or Headless Host.
It owns the grammY Bot, numeric Telegram user allowlist, user selections,
idempotency cache, and a per-session FIFO. A narrow DSH adapter owns every
rc.8 import.

Remote submission does not treat Agent.followup() as a completion API. The
adapter creates an identified user message, subscribes before submission,
finds the turn containing that exact message id, and collects that turn's
assistant/message and turn/end events. This remains deterministic if the Web
GUI submits work to the same session.

The multi-node phase keeps the same single Telegram Gateway. Each node opens
an outbound WSS connection, performs challenge authentication with a persistent
device key, advertises capabilities, and exchanges the versioned protocol in
packages/protocol. Commands and events carry request and idempotency ids.

## Security Boundaries

- Only private Telegram chats from configured numeric user ids are accepted.
- Bot tokens are credential references, never literal plugin configuration.
- Nodes never expose a DSH GUI or inbound management port.
- Approval decisions must bind user, node, session, request digest, and expiry.
- Timeout, disconnect, or failed verification denies an approval.
- This channel never changes DSH sandbox or approval policy.
- Logs may contain ids and outcomes, but not secrets or raw approval arguments.

## MVP Scope

The MVP supports project and session listing, target selection, session
creation, status, cancellation that preserves queued work, plain text turns,
duplicate Telegram update suppression, and final replies.

## Deferred

Multi-node WSS transport, pairing UI, streaming message edits, attachments,
approval buttons, user questions, group chats, Forum Topics, distributed state,
and durable audit storage are subsequent milestones.

## Consequences

One Gateway is a deliberate availability boundary. It avoids split-brain Bot
polling and gives routing, authorization, and audit one owner. RC upgrades only
replace the adapter and its contract tests.

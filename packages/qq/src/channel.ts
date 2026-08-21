import { BoundedIdSet, KeyedSerialQueue, type ControlReply, type DshControlPlane, type TurnProgress } from "@wsxcant/dsh-channel-telegram-gateway";
import type { QQOpenApiClient, QQReplyContext } from "./api.js";
import { QQProgressReporter } from "./progress.js";
import { QQApiError, type QQC2CMessage, type QQGatewayPayload } from "./types.js";
import type { QQGatewayConnection } from "./websocket.js";

interface NumberedMenu { readonly actorId: string; readonly expiresAt: number; readonly callbacks: readonly string[]; }
export interface QQC2CChannelOptions {
  readonly control: DshControlPlane;
  readonly api: QQOpenApiClient;
  readonly allowedOpenIds: readonly string[];
  readonly menuTtlMs?: number;
  readonly progressIntervalMs?: number;
  readonly identityLookupEnabled?: boolean;
  readonly now?: () => number;
}

export class QQC2CChannel {
  private readonly allowed: Set<string>;
  private readonly menus = new Map<string, NumberedMenu>();
  private readonly external = new Map<string, { readonly sessionId: string; readonly turn: number; readonly reporter: QQProgressReporter }>();
  private readonly seen = new BoundedIdSet();
  private readonly queues = new KeyedSerialQueue();
  private readonly now: () => number;
  private readonly menuTtlMs: number;
  private readonly unsubscribeProgress: () => void;
  private disposed = false;

  constructor(private readonly options: QQC2CChannelOptions) {
    const values = options.allowedOpenIds.map((value) => value.trim()).filter(Boolean);
    if (values.length === 0) throw new Error("QQ allowedOpenIds must not be empty");
    this.allowed = new Set(values);
    this.now = options.now ?? Date.now;
    this.menuTtlMs = options.menuTtlMs ?? 10 * 60_000;
    this.unsubscribeProgress = options.control.onSessionProgress((event) => this.handleExternalProgress(event.actorId, event.conversationId, event.progress));
  }

  async run(connection: QQGatewayConnection, signal: AbortSignal): Promise<void> { await connection.run(signal, (message, payload) => this.handleMessage(message, payload)); }

  async handleMessage(message: QQC2CMessage, _payload?: QQGatewayPayload): Promise<void> {
    return this.queues.run(message.userOpenId, () => this.processMessage(message));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeProgress();
    this.menus.clear();
    this.external.clear();
  }

  private async processMessage(message: QQC2CMessage): Promise<void> {
    if (this.disposed || message.content === "") return;
    if (!this.seen.addIfNew(message.dedupeKey)) return;
    if (!this.allowed.has(message.userOpenId)) {
      if (this.options.identityLookupEnabled === true && message.content.trim().toLowerCase() === "/openid") {
        await this.sendParts(message.userOpenId, "Your QQ user OpenID:\n" + message.userOpenId, message.id);
      }
      return;
    }
    const choice = /^\d+$/u.test(message.content) ? Number(message.content) : undefined;
    const menu = this.menus.get(message.userOpenId);
    if (choice !== undefined && menu !== undefined) {
      if (menu.expiresAt <= this.now() || menu.actorId !== message.userOpenId) {
        this.menus.delete(message.userOpenId);
        await this.sendParts(message.userOpenId, "This menu expired. Send /menu again.", message.id);
        return;
      }
      const data = menu.callbacks[choice - 1];
      if (data === undefined) {
        await this.sendParts(message.userOpenId, "Unknown menu option. Send a listed number or /menu.", message.id);
        return;
      }
      const result = await this.options.control.handleCallback({ updateId: message.dedupeKey + ":choice", actorId: message.userOpenId, conversationId: message.userOpenId, data });
      if (this.disposed) return;
      if (result.view !== undefined) await this.sendReply(message, result.view); else await this.sendParts(message.userOpenId, result.answer, message.id);
      return;
    }
    const reporter = new QQProgressReporter({
      api: this.options.api,
      userOpenId: message.userOpenId,
      msgId: message.id,
      ...(this.options.progressIntervalMs === undefined ? {} : { intervalMs: this.options.progressIntervalMs }),
      now: this.now,
      shouldStop: () => this.disposed
    });
    const replies = await this.options.control.handle({ updateId: message.dedupeKey, actorId: message.userOpenId, conversationId: message.userOpenId, text: message.content }, (progress) => reporter.update(progress));
    if (this.disposed) return;
    for (const reply of replies) await this.sendReply(message, reply);
  }

  private async sendReply(message: QQC2CMessage, reply: ControlReply): Promise<void> {
    if (this.disposed) return;
    if (typeof reply === "string") { await this.sendParts(message.userOpenId, reply, message.id); return; }
    const callbacks = reply.rows.flat().map((button) => button.callbackData);
    this.menus.set(message.userOpenId, { actorId: message.userOpenId, callbacks, expiresAt: this.now() + this.menuTtlMs });
    const lines = reply.rows.flat().map((button, index) => String(index + 1) + ". " + button.text);
    await this.sendParts(message.userOpenId, [reply.text, "", ...lines].join("\n"), message.id);
  }

  private async sendParts(userOpenId: string, text: string, msgId?: string): Promise<void> {
    let seq = 0;
    for (const part of splitText(text, 1_800)) {
      if (this.disposed) return;
      seq += 1;
      const context: QQReplyContext = msgId === undefined ? {} : { msgId, msgSeq: seq };
      try { await this.options.api.sendC2CText(userOpenId, part, context); }
      catch (error) {
        if (msgId === undefined || !isExpiredReply(error)) throw error;
        await this.options.api.sendC2CText(userOpenId, part);
      }
    }
  }

  private async handleExternalProgress(actorId: string, conversationId: string, progress: TurnProgress): Promise<void> {
    if (this.disposed || !this.allowed.has(actorId) || actorId !== conversationId) return;
    await this.queues.run(actorId, async () => {
      if (this.disposed || !this.allowed.has(actorId) || actorId !== conversationId) return;
      const turn = progressTurn(progress);
      if (turn === undefined) return;
      let current = this.external.get(conversationId);
      if (current === undefined || current.sessionId !== progress.sessionId || current.turn !== turn) {
        current = {
          sessionId: progress.sessionId,
          turn,
          reporter: new QQProgressReporter({
            api: this.options.api,
            userOpenId: actorId,
            ...(this.options.progressIntervalMs === undefined ? {} : { intervalMs: this.options.progressIntervalMs }),
            now: this.now,
            shouldStop: () => this.disposed
          })
        };
        this.external.set(conversationId, current);
      }
      await current.reporter.update(progress);
      if (progress.type === "turn-end" || progress.type === "failed") { if (this.external.get(conversationId) === current) this.external.delete(conversationId); }
    });
  }
}

function progressTurn(progress: TurnProgress): number | undefined { switch (progress.type) { case "turn-start": case "assistant-delta": case "assistant-message": case "tool-start": case "tool-end": return progress.turn; case "turn-end": return progress.result.turn; default: return undefined; } }
function splitText(text: string, max: number): readonly string[] { const chars = Array.from(text); const result: string[] = []; for (let i = 0; i < chars.length; i += max) result.push(chars.slice(i, i + max).join("")); return result.length ? result : ["OK"]; }
function isExpiredReply(error: unknown): boolean { return error instanceof QQApiError && (String(error.code) === "40034005" || String(error.code) === "40034024"); }

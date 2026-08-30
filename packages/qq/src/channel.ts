import { BoundedIdSet, KeyedSerialQueue, type ControlReply, type DshControlPlane, type TurnProgress } from "@wsxcant/dsh-channel-telegram-gateway";
import type { QQOpenApiClient, QQReplyContext } from "./api.js";
import { QQProgressReporter } from "./progress.js";
import { QQApiError, type QQC2CInteraction, type QQC2CMessage, type QQGatewayPayload } from "./types.js";
import type { QQGatewayConnection } from "./websocket.js";

interface NumberedMenu { readonly actorId: string; readonly expiresAt: number; readonly buttons: readonly { readonly text: string; readonly callbackData: string }[]; }
export interface QQMenuFallback { readonly name: string; readonly status?: number; readonly code?: number | string; }
export interface QQC2CChannelOptions {
  readonly control: DshControlPlane;
  readonly api: QQOpenApiClient;
  readonly allowedOpenIds: readonly string[];
  readonly menuTtlMs?: number;
  readonly progressIntervalMs?: number;
  readonly identityLookupEnabled?: boolean;
  readonly onMenuFallback?: (error: QQMenuFallback) => void;
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

  async run(connection: QQGatewayConnection, signal: AbortSignal): Promise<void> {
    await connection.run(signal, (message, payload) => this.handleMessage(message, payload), (interaction) => this.handleInteraction(interaction));
  }

  async handleMessage(message: QQC2CMessage, _payload?: QQGatewayPayload): Promise<void> {
    if (this.allowed.has(message.userOpenId) && isDirectTurnText(message.content)) return this.processMessage(message);
    return this.queues.run(message.userOpenId, () => this.processMessage(message));
  }

  async handleInteraction(interaction: QQC2CInteraction): Promise<void> {
    await this.options.api.acknowledgeInteraction(interaction.id);
    return this.queues.run(interaction.userOpenId, () => this.processInteraction(interaction));
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
        await this.sendParts(message.userOpenId, "你的 QQ 用户 OpenID：\n" + message.userOpenId, message.id);
      }
      return;
    }
    const normalized = message.content.trim().toLowerCase();
    const menuInput = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    const choice = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
    const shortcut = menuInput === "back" || menuInput === "b" || menuInput === "返回" ? "back" : menuInput === "refresh" || menuInput === "r" || menuInput === "刷新" ? "refresh" : undefined;
    const menu = this.menus.get(message.userOpenId);
    if ((choice !== undefined || shortcut !== undefined) && menu !== undefined) {
      if (menu.expiresAt <= this.now() || menu.actorId !== message.userOpenId) {
        this.menus.delete(message.userOpenId);
        await this.sendParts(message.userOpenId, "菜单已过期，请重新发送 /menu。", message.id);
        return;
      }
      const button = shortcut === undefined ? menu.buttons[(choice ?? 0) - 1] : menu.buttons.find((item) => shortcutOfLabel(item.text) === shortcut);
      if (button === undefined) {
        await this.sendParts(message.userOpenId, shortcut === undefined ? "无效的菜单选项，请回复列表中的数字、/back 或 /refresh。" : "当前菜单没有该操作，请重新发送 /menu。", message.id);
        return;
      }
      const result = await this.options.control.handleCallback({ updateId: message.dedupeKey + ":choice:" + (shortcut ?? String(choice)), actorId: message.userOpenId, conversationId: message.userOpenId, data: button.callbackData });
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

  private async processInteraction(interaction: QQC2CInteraction): Promise<void> {
    if (this.disposed || !this.seen.addIfNew(interaction.dedupeKey) || !this.allowed.has(interaction.userOpenId)) return;
    const result = await this.options.control.handleCallback({ updateId: interaction.dedupeKey, actorId: interaction.userOpenId, conversationId: interaction.userOpenId, data: interaction.data });
    if (this.disposed) return;
    if (result.view !== undefined) await this.sendMenu(interaction.userOpenId, result.view);
    else await this.sendParts(interaction.userOpenId, result.answer);
  }

  private async sendReply(message: QQC2CMessage, reply: ControlReply): Promise<void> {
    if (this.disposed) return;
    if (typeof reply === "string") { await this.sendParts(message.userOpenId, reply, message.id); return; }
    await this.sendMenu(message.userOpenId, reply, message.id);
  }

  private async sendMenu(userOpenId: string, reply: Exclude<ControlReply, string>, msgId?: string): Promise<void> {
    const buttons = reply.rows.flat().map((button) => ({ text: button.text, callbackData: button.callbackData }));
    this.menus.set(userOpenId, { actorId: userOpenId, buttons, expiresAt: this.now() + this.menuTtlMs });
    const context: QQReplyContext = msgId === undefined ? {} : { msgId, msgSeq: 1 };
    try {
      await this.options.api.sendC2CMenu(userOpenId, reply.text + "\n\n请点击下方按钮选择。", reply.rows, context);
      return;
    } catch (error) {
      if (this.disposed) return;
      try { this.options.onMenuFallback?.(menuFallback(error)); } catch { /* Preserve the text fallback. */ }
    }
    const lines = buttons.map((button, index) => String(index + 1) + ". " + button.text);
    await this.sendParts(userOpenId, [reply.text, "", ...lines, "", "请回复数字、/back 或 /refresh。"].join("\n"), msgId);
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
function isDirectTurnText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized.startsWith("/") || /^\d+$/u.test(normalized)) return false;
  return normalized !== "back" && normalized !== "b" && normalized !== "返回" && normalized !== "refresh" && normalized !== "r" && normalized !== "刷新";
}

function shortcutOfLabel(value: string): "back" | "refresh" | undefined { const normalized = value.trim().toLowerCase(); return normalized === "back" || normalized === "返回" ? "back" : normalized === "refresh" || normalized === "刷新" ? "refresh" : undefined; }
function menuFallback(error: unknown): QQMenuFallback { return error instanceof QQApiError ? { name: error.name, ...(error.status === undefined ? {} : { status: error.status }), ...(error.code === undefined ? {} : { code: error.code }) } : { name: error instanceof Error ? error.name : "UnknownError" }; }

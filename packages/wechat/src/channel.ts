import { BoundedIdSet, KeyedSerialQueue, type ControlReply, type DshControlPlane, type TurnProgress } from "@wsxcant/dsh-channel-telegram-gateway";
import { WechatProgressReporter } from "./progress.js";
import type { WechatBotLike, WechatIncomingMessage } from "./types.js";

interface NumberedMenu {
  readonly actorId: string;
  readonly expiresAt: number;
  readonly buttons: readonly { readonly text: string; readonly callbackData: string }[];
}

export interface WechatPrivateChannelOptions {
  readonly control: DshControlPlane;
  readonly bot: WechatBotLike;
  readonly allowedUserIds: readonly string[];
  readonly identityLookupEnabled?: boolean;
  readonly menuTtlMs?: number;
  readonly now?: () => number;
  readonly onInbound?: () => void;
}

export class WechatPrivateChannel {
  private readonly allowed: Set<string>;
  private readonly seen = new BoundedIdSet();
  private readonly queues = new KeyedSerialQueue();
  private readonly menus = new Map<string, NumberedMenu>();
  private readonly external = new Map<string, { readonly sessionId: string; readonly turn: number; readonly reporter: WechatProgressReporter }>();
  private readonly now: () => number;
  private readonly menuTtlMs: number;
  private readonly unsubscribeProgress: () => void;
  private attached = false;
  private disposed = false;

  constructor(private readonly options: WechatPrivateChannelOptions) {
    const values = options.allowedUserIds.map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 && options.identityLookupEnabled !== true) throw new Error("WeChat allowedUserIds must not be empty unless identity lookup is enabled");
    this.allowed = new Set(values);
    this.now = options.now ?? Date.now;
    this.menuTtlMs = options.menuTtlMs ?? 10 * 60_000;
    this.unsubscribeProgress = options.control.onSessionProgress((event) => this.handleExternalProgress(event.actorId, event.conversationId, event.progress));
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.options.bot.onMessage((message) => this.handleMessage(message));
  }

  handleMessage(message: WechatIncomingMessage): Promise<void> {
    return this.queues.run(message.userId, () => this.processMessage(message));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProgress();
    this.menus.clear();
    this.external.clear();
  }

  private async processMessage(message: WechatIncomingMessage): Promise<void> {
    if (this.disposed) return;
    this.options.onInbound?.();
    if (message.type !== "text" || message.text.trim() === "") return;
    const updateId = messageKey(message);
    if (!this.seen.addIfNew(updateId)) return;
    const normalized = message.text.trim().toLowerCase();
    if (!this.allowed.has(message.userId)) {
      if (this.options.identityLookupEnabled === true && normalized === "/userid") {
        await this.options.bot.reply(message, "你的微信 iLink 用户 ID：\n" + message.userId);
      }
      return;
    }

    const menuInput = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    const choice = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
    const shortcut = menuInput === "back" || menuInput === "b" || menuInput === "返回" ? "back" : menuInput === "refresh" || menuInput === "r" || menuInput === "刷新" ? "refresh" : undefined;
    const menu = this.menus.get(message.userId);
    if ((choice !== undefined || shortcut !== undefined) && menu !== undefined) {
      if (menu.expiresAt <= this.now() || menu.actorId !== message.userId) {
        this.menus.delete(message.userId);
        await this.options.bot.reply(message, "菜单已过期，请重新发送 /menu。");
        return;
      }
      const button = shortcut === undefined ? menu.buttons[(choice ?? 0) - 1] : menu.buttons.find((item) => shortcutOfLabel(item.text) === shortcut);
      if (button === undefined) {
        await this.options.bot.reply(message, shortcut === undefined ? "无效的菜单选项，请回复列表中的数字、/back 或 /refresh。" : "当前菜单没有该操作，请重新发送 /menu。");
        return;
      }
      const result = await this.options.control.handleCallback({ updateId: updateId + ":choice:" + (shortcut ?? String(choice)), actorId: message.userId, conversationId: message.userId, data: button.callbackData });
      if (this.disposed) return;
      if (result.view !== undefined) await this.sendReply(message, result.view);
      else await this.options.bot.reply(message, result.answer);
      return;
    }

    const reporter = new WechatProgressReporter({ bot: this.options.bot, userId: message.userId, message, shouldStop: () => this.disposed });
    const replies = await this.options.control.handle({ updateId, actorId: message.userId, conversationId: message.userId, text: message.text }, (progress) => reporter.update(progress));
    if (this.disposed) return;
    for (const reply of replies) await this.sendReply(message, reply);
  }

  private async sendReply(message: WechatIncomingMessage, reply: ControlReply): Promise<void> {
    if (typeof reply === "string") { await this.options.bot.reply(message, reply); return; }
    const buttons = reply.rows.flat().map((button) => ({ text: button.text, callbackData: button.callbackData }));
    this.menus.set(message.userId, { actorId: message.userId, buttons, expiresAt: this.now() + this.menuTtlMs });
    const lines = buttons.map((button, index) => String(index + 1) + ". " + button.text);
    await this.options.bot.reply(message, [reply.text, "", ...lines, "", "请回复数字、/back 或 /refresh。"].join("\n"));
  }

  private async handleExternalProgress(actorId: string, conversationId: string, progress: TurnProgress): Promise<void> {
    if (this.disposed || !this.allowed.has(actorId) || actorId !== conversationId) return;
    await this.queues.run(actorId, async () => {
      if (this.disposed || !this.allowed.has(actorId)) return;
      const turn = progressTurn(progress);
      if (turn === undefined) return;
      let current = this.external.get(conversationId);
      if (current === undefined || current.sessionId !== progress.sessionId || current.turn !== turn) {
        current = { sessionId: progress.sessionId, turn, reporter: new WechatProgressReporter({ bot: this.options.bot, userId: actorId, shouldStop: () => this.disposed }) };
        this.external.set(conversationId, current);
      }
      await current.reporter.update(progress);
      if (progress.type === "turn-end" || progress.type === "failed") if (this.external.get(conversationId) === current) this.external.delete(conversationId);
    });
  }
}

function messageKey(message: WechatIncomingMessage): string {
  const raw = message.raw;
  return [message.userId, raw.message_id ?? "", raw.seq ?? "", raw.session_id ?? "", message.timestamp.getTime()].join(":");
}

function progressTurn(progress: TurnProgress): number | undefined {
  switch (progress.type) {
    case "turn-start": case "assistant-delta": case "assistant-message": case "tool-start": case "tool-end": return progress.turn;
    case "turn-end": return progress.result.turn;
    default: return undefined;
  }
}

function shortcutOfLabel(value: string): "back" | "refresh" | undefined { const normalized = value.trim().toLowerCase(); return normalized === "back" || normalized === "返回" ? "back" : normalized === "refresh" || normalized === "刷新" ? "refresh" : undefined; }

import type { TurnProgress } from "@wsxcant/dsh-channel-telegram-gateway";
import type { WechatBotLike, WechatIncomingMessage } from "./types.js";

export interface WechatProgressReporterOptions {
  readonly bot: WechatBotLike;
  readonly userId: string;
  readonly message?: WechatIncomingMessage;
  readonly shouldStop?: () => boolean;
}

export class WechatProgressReporter {
  private tail = Promise.resolve();
  private started = false;
  private queuedSent = false;
  private final = false;

  constructor(private readonly options: WechatProgressReporterOptions) {}

  update(progress: TurnProgress): Promise<void> {
    this.tail = this.tail.then(() => this.apply(progress));
    return this.tail;
  }

  private async apply(progress: TurnProgress): Promise<void> {
    if (this.final || this.options.shouldStop?.()) { this.final = true; return; }
    if (!this.started && (progress.type === "queued" || progress.type === "turn-start")) {
      this.started = true;
      await this.options.bot.sendTyping(this.options.userId).catch(() => undefined);
    }
    if (this.options.shouldStop?.()) { this.final = true; return; }
    if (progress.type === "queued" && progress.waiting) { if (!this.queuedSent) { this.queuedSent = true; await this.send("当前会话正在处理中，消息已加入队列。"); } return; }
    if (progress.type === "turn-start") {
      await this.send("Running turn " + String(progress.turn) + "...");
      return;
    }
    if (progress.type === "turn-end") {
      this.final = true;
      await this.options.bot.stopTyping(this.options.userId).catch(() => undefined);
      await this.send(progress.result.text || ("Turn ended: " + progress.result.reason + "."));
      return;
    }
    if (progress.type === "failed") {
      this.final = true;
      await this.options.bot.stopTyping(this.options.userId).catch(() => undefined);
      await this.send(progress.message);
    }
  }

  private async send(text: string): Promise<void> {
    if (this.options.shouldStop?.()) return;
    if (this.options.message !== undefined) await this.options.bot.reply(this.options.message, text);
    else await this.options.bot.send(this.options.userId, text);
  }
}

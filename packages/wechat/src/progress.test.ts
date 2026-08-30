import type { IncomingMessage, SendContent, WechatBotLike } from "./types.js";
import { describe, expect, it } from "vitest";
import { WechatProgressReporter } from "./progress.js";

class Bot implements WechatBotLike {
  readonly values: string[] = [];
  onMessage() { return this; }
  async reply(_message: IncomingMessage, content: SendContent) { this.values.push(typeof content === "string" ? content : "media"); }
  async send(_userId: string, content: SendContent) { this.values.push(typeof content === "string" ? content : "media"); }
  async sendTyping() { this.values.push("typing:start"); }
  async stopTyping() { this.values.push("typing:stop"); }
  async download() { return null; }
}

describe("WechatProgressReporter", () => {
  it("sends one visible receipt when accepted behind active work", async () => {
    const bot = new Bot(); const reporter = new WechatProgressReporter({ bot, userId: "wx" });
    await reporter.update({ type: "queued", sessionId: "s", waiting: true });
    await reporter.update({ type: "queued", sessionId: "s", waiting: true });
    expect(bot.values).toEqual(["typing:start", "当前会话正在处理中，消息已加入队列。"]);
  });
});

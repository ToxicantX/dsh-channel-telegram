import { DshControlPlane, type ControlReply, type DshInboundAttachment, type DshPort, type TurnProgress, type TurnProgressListener, type TurnResult } from "@wsxcant/dsh-channel-telegram-gateway";
import { describe, expect, it } from "vitest";
import { WechatPrivateChannel } from "./channel.js";
import type { IncomingMessage, SendContent, WechatBotLike } from "./types.js";

class Port implements DshPort {
  readonly watchers = new Set<TurnProgressListener>();
  sends = 0;
  attachments: readonly DshInboundAttachment[] | undefined;
  async listComputers() { return [{ id: "local", title: "Local", status: "online" }] as const; }
  async listProjects() { return [{ id: "p1", title: "Project", path: "C:/p1", status: "online" }] as const; }
  async listSessions() { return [{ id: "s1", title: "Session", status: "idle" }] as const; }
  async listAgentPresets() { return [{ id: "default", title: "Default", isDefault: true }] as const; }
  async createSession() { return { id: "s1", title: "Session", status: "idle" } as const; }
  async send(sessionId: string, text: string, listener?: TurnProgressListener, attachments?: readonly DshInboundAttachment[]): Promise<TurnResult> {
    this.sends += 1;
    this.attachments = attachments;
    listener?.({ type: "turn-start", sessionId, turn: 1 });
    const result = { text: "reply:" + text, reason: "completed", turn: 1 } as const;
    listener?.({ type: "turn-end", sessionId, result });
    return result;
  }
  async status() { return "idle" as const; }
  async stop() { return true; }
  watchSession(_id: string, listener: TurnProgressListener): () => void { this.watchers.add(listener); return () => { this.watchers.delete(listener); }; }
  emit(progress: TurnProgress): void { for (const listener of this.watchers) listener(progress); }
}

class Bot implements WechatBotLike {
  readonly replies: { userId: string; text: string }[] = [];
  readonly sends: { userId: string; text: string }[] = [];
  readonly typing: string[] = [];
  downloaded: Awaited<ReturnType<WechatBotLike["download"]>> = null;
  handler?: (message: IncomingMessage) => void | Promise<void>;
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>) { this.handler = handler; return this; }
  async reply(message: IncomingMessage, content: SendContent) { this.replies.push({ userId: message.userId, text: textOf(content) }); }
  async send(userId: string, content: SendContent) { this.sends.push({ userId, text: textOf(content) }); }
  async sendTyping(userId: string) { this.typing.push("start:" + userId); }
  async stopTyping(userId: string) { this.typing.push("stop:" + userId); }
  async download(_message: IncomingMessage) { return this.downloaded; }
}

function textOf(content: SendContent): string { return typeof content === "string" ? content : "text" in content ? content.text : "[media]"; }
function message(id: number, text: string, userId = "wx-A"): IncomingMessage {
  return { userId, text, type: "text", timestamp: new Date(1_000 + id), images: [], voices: [], files: [], videos: [], raw: { message_id: id, seq: id, session_id: "s" }, _contextToken: "ctx" } as unknown as IncomingMessage;
}

function mediaMessage(id: number, type: "image" | "file", text: string): IncomingMessage {
  const item = type === "image" ? { type: 2, image_item: { file_name: "capture.png" } } : { type: 4, file_item: { file_name: "notes.txt", len: "4" } };
  return { ...message(id, text), type, images: type === "image" ? [item] : [], files: type === "file" ? [item] : [], raw: { ...message(id, text).raw, item_list: [item] } } as unknown as IncomingMessage;
}
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

describe("WechatPrivateChannel", () => {
  it("rejects unauthorized users and supports temporary identity lookup", async () => {
    const bot = new Bot(); const port = new Port(); let inbound = 0;
    const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: [], identityLookupEnabled: true, onInbound: () => { inbound += 1; } });
    await channel.handleMessage(message(1, "/menu", "wx-B"));
    await channel.handleMessage(message(2, "/userid", "wx-B"));
    await channel.handleMessage({ ...message(3, "", "wx-B"), type: "image" });
    expect(bot.replies).toEqual([{ userId: "wx-B", text: "你的微信 iLink 用户 ID：\nwx-B" }]);
    expect(port.sends).toBe(0); expect(inbound).toBe(3);
    channel.dispose();
  });

  it("renders numbered menus with back and refresh shortcuts", async () => {
    const bot = new Bot(); const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(new Port(), {}), allowedUserIds: ["wx-A"] });
    await channel.handleMessage(message(1, "/computers"));
    expect(bot.replies[0]?.text).toContain("1. Local (online)");
    await channel.handleMessage(message(2, "1"));
    expect(bot.replies[1]?.text).toContain("选择项目");
    await channel.handleMessage(message(3, "/返回"));
    expect(bot.replies[2]?.text).toContain("选择主机");
    await channel.handleMessage(message(4, "1"));
    await channel.handleMessage(message(5, "r"));
    expect(bot.replies.at(-1)?.text).toContain("选择项目");
    channel.dispose();
  });

  it("deduplicates messages and relays one process node plus final result", async () => {
    const bot = new Bot(); const port = new Port(); const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"] });
    await channel.handleMessage(message(1, "/use computer local"));
    await channel.handleMessage(message(2, "/use project p1"));
    await channel.handleMessage(message(3, "/use session s1"));
    bot.replies.length = 0;
    const inbound = message(4, "hello");
    await channel.handleMessage(inbound); await channel.handleMessage(inbound);
    expect(port.sends).toBe(1);
    expect(bot.typing).toEqual(["start:wx-A", "stop:wx-A"]);
    expect(bot.replies.map((item) => item.text)).toEqual(["Running turn 1...", "reply:hello"]);
    channel.dispose();
  });

  it("relays external selected-session progress and stops after dispose", async () => {
    const bot = new Bot(); const port = new Port(); const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"] });
    await channel.handleMessage(message(1, "/use computer local")); await channel.handleMessage(message(2, "/use project p1")); await channel.handleMessage(message(3, "/use session s1"));
    port.emit({ type: "turn-start", sessionId: "s1", turn: 2 }); port.emit({ type: "turn-end", sessionId: "s1", result: { text: "from GUI", reason: "completed", turn: 2 } });
    await flush();
    expect(bot.sends.map((item) => item.text)).toEqual(["Running turn 2...", "from GUI"]);
    channel.dispose();
    port.emit({ type: "turn-start", sessionId: "s1", turn: 3 }); await flush();
    expect(bot.sends).toHaveLength(2);
  });

  it("attaches to the SDK message handler once", async () => {
    const bot = new Bot(); const control = { handle: async (): Promise<readonly ControlReply[]> => ["ok"], handleCallback: async () => ({ answer: "ok" }), onSessionProgress: () => () => undefined };
    const channel = new WechatPrivateChannel({ bot, control: control as unknown as DshControlPlane, allowedUserIds: ["wx-A"] });
    channel.attach(); channel.attach();
    await bot.handler?.(message(1, "/menu"));
    expect(bot.replies).toEqual([{ userId: "wx-A", text: "ok" }]);
  });

  it("downloads an inbound image and forwards its caption and attachment", async () => {
    const bot = new Bot(); const port = new Port(); const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"] });
    await channel.handleMessage(message(1, "/use computer local")); await channel.handleMessage(message(2, "/use project p1")); await channel.handleMessage(message(3, "/use session s1"));
    bot.downloaded = { type: "image", data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), fileName: "capture.png" };
    await channel.handleMessage(mediaMessage(4, "image", "caption"));
    expect(port.attachments).toEqual([{ type: "image", data: bot.downloaded.data, mediaType: "image/png", name: "capture.png" }]);
    expect(bot.replies).toContainEqual({ userId: "wx-A", text: "Running turn 1..." });
  });

  it("downloads an inbound text file and preserves its filename", async () => {
    const bot = new Bot(); const port = new Port(); const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"] });
    await channel.handleMessage(message(1, "/use computer local")); await channel.handleMessage(message(2, "/use project p1")); await channel.handleMessage(message(3, "/use session s1"));
    bot.downloaded = { type: "file", data: new TextEncoder().encode("test"), fileName: "notes.txt" };
    await channel.handleMessage(mediaMessage(4, "file", "please inspect"));
    expect(port.attachments?.[0]).toMatchObject({ type: "file", mediaType: "text/plain", name: "notes.txt" });
  });

  it("rejects oversized, unsupported, and failed media without calling DSH", async () => {
    const bot = new Bot(); const port = new Port(); const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"], maxAttachmentBytes: 4 });
    await channel.handleMessage(message(1, "/use computer local")); await channel.handleMessage(message(2, "/use project p1")); await channel.handleMessage(message(3, "/use session s1"));
    bot.downloaded = { type: "image", data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), fileName: "capture.png" };
    await channel.handleMessage(mediaMessage(4, "image", "too large"));
    expect(port.sends).toBe(0); expect(bot.replies.at(-1)?.text).toContain("无法读取");

    const unsupported = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"] });
    bot.downloaded = { type: "file", data: Uint8Array.from([1, 2]), fileName: "program.exe" };
    await unsupported.handleMessage(mediaMessage(5, "file", "bad type"));
    expect(port.sends).toBe(0); expect(bot.replies.at(-1)?.text).toContain("无法读取");

    const failed = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"] });
    bot.downloaded = null;
    await failed.handleMessage(mediaMessage(6, "image", "download failed"));
    expect(port.sends).toBe(0); expect(bot.replies.at(-1)?.text).toContain("无法读取");
  });

  it("rejects more media items than the downloader can safely represent", async () => {
    const bot = new Bot(); const port = new Port(); const channel = new WechatPrivateChannel({ bot, control: new DshControlPlane(port, {}), allowedUserIds: ["wx-A"] });
    const incoming = { ...mediaMessage(1, "image", "two images"), images: [{}, {}] } as IncomingMessage;
    await channel.handleMessage(incoming);
    expect(bot.replies.at(-1)?.text).toContain("无法读取"); expect(port.sends).toBe(0);
  });
});

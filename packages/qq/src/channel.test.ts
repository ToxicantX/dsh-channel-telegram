import { DshControlPlane, type ControlReply, type DshPort, type TurnProgress, type TurnProgressListener, type TurnResult } from "@wsxcant/dsh-channel-telegram-gateway";
import { describe, expect, it } from "vitest";
import type { QQInlineButton, QQOpenApiClient, QQReplyContext } from "./api.js";
import { QQC2CChannel } from "./channel.js";
import { QQApiError, type QQC2CInteraction, type QQC2CMessage } from "./types.js";

class Port implements DshPort {
  readonly watchers = new Set<TurnProgressListener>();
  gate?: Promise<void>;
  started = 0;
  async listComputers() { return [{ id: "local", title: "Local", status: "online" }] as const; }
  async listProjects() { return [{ id: "p1", title: "Project", path: "C:/p1", status: "online" }] as const; }
  async listSessions() { return [{ id: "s1", title: "Session 1", status: "idle" }, { id: "s2", title: "Session 2", status: "idle" }] as const; }
  async listAgentPresets() { return [{ id: "default", title: "Default", isDefault: true }] as const; }
  async createSession() { return { id: "s2", title: "New", status: "idle" } as const; }
  async send(sessionId: string, text: string, listener?: TurnProgressListener): Promise<TurnResult> {
    this.started += 1;
    if (this.gate !== undefined) await this.gate;
    listener?.({ type: "turn-start", sessionId, turn: 1 });
    const result = { text: "reply:" + text, reason: "completed", turn: 1 } as const;
    listener?.({ type: "turn-end", sessionId, result });
    return result;
  }
  async status() { return "idle" as const; } async stop() { return true; }
  watchSession(_sessionId: string, listener: TurnProgressListener): () => void { this.watchers.add(listener); return () => { this.watchers.delete(listener); }; }
  emit(value: TurnProgress): void { for (const listener of this.watchers) listener(value); }
}
class Api {
  readonly sent: { user: string; content: string; context?: QQReplyContext }[] = [];
  readonly menus: { user: string; content: string; rows: readonly (readonly QQInlineButton[])[]; context?: QQReplyContext }[] = [];
  readonly input: number[] = [];
  readonly acknowledged: string[] = [];
  failMenus = false;
  async sendC2CText(user: string, content: string, context?: QQReplyContext) { this.sent.push({ user, content, context }); }
  async sendC2CMenu(user: string, content: string, rows: readonly (readonly QQInlineButton[])[], context?: QQReplyContext) {
    if (this.failMenus) throw new QQApiError("keyboard unsupported", 400, 40054009);
    this.menus.push({ user, content, rows, context });
  }
  async acknowledgeInteraction(id: string) { this.acknowledged.push(id); }
  async sendC2CInputNotify(_user: string, _msg: string, seq: number) { this.input.push(seq); }
}
const message = (id: string, content: string, userOpenId = "openid-A"): QQC2CMessage => ({ id, userOpenId, content, msgIndex: id, dedupeKey: id + ":" + id });
const interaction = (id: string, data: string, userOpenId = "openid-A"): QQC2CInteraction => ({ id, userOpenId, data, buttonId: "button-1", dedupeKey: "interaction:" + id });
async function flush(): Promise<void> { await new Promise<void>((resolve) => { setImmediate(resolve); }); }

describe("QQC2CChannel", () => {
  it("rejects unauthorized OpenIDs before DSH or QQ replies", async () => {
    const api = new Api(); const channel = new QQC2CChannel({ control: new DshControlPlane(new Port(), {}), api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A"] });
    await channel.handleMessage(message("m1", "/menu", "openid-B")); expect(api.sent).toEqual([]); channel.dispose();
  });
  it("reveals only the sender's OpenID when diagnostic lookup is enabled", async () => {
    const port = new Port(); const api = new Api();
    const channel = new QQC2CChannel({ control: new DshControlPlane(port, {}), api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A"], identityLookupEnabled: true });
    await channel.handleMessage(message("m1", "/openid", "openid-B"));
    expect(api.sent).toEqual([{ user: "openid-B", content: "你的 QQ 用户 OpenID：\nopenid-B", context: { msgId: "m1", msgSeq: 1 } }]);
    expect(port.started).toBe(0);
    await channel.handleMessage(message("m2", "/menu", "openid-B"));
    expect(api.sent).toHaveLength(1);
    channel.dispose();
  });

  it("sends native Chinese menus and handles acknowledged button callbacks", async () => {
    const api = new Api(); const channel = new QQC2CChannel({ control: new DshControlPlane(new Port(), {}), api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A"] });
    await channel.handleMessage(message("m1", "/computers"));
    expect(api.sent).toEqual([]);
    expect(api.menus[0]?.content).toContain("选择主机");
    expect(api.menus[0]?.rows.flat().map((button) => button.text)).toEqual(expect.arrayContaining(["Local (online)", "返回", "刷新"]));
    const callbackData = api.menus[0]!.rows[0]![0]!.callbackData;
    await channel.handleInteraction(interaction("i1", callbackData));
    expect(api.acknowledged).toEqual(["i1"]);
    expect(api.menus[1]?.content).toContain("选择项目");
    channel.dispose();
  });

  it("falls back to numbered Chinese menus and resolves choices through opaque callbacks", async () => {
    const fallbacks: unknown[] = []; const api = new Api(); api.failMenus = true; const channel = new QQC2CChannel({ control: new DshControlPlane(new Port(), {}), api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A"], onMenuFallback: (error) => { fallbacks.push(error); } });
    await channel.handleMessage(message("m1", "/computers")); expect(api.sent[0]?.content).toContain("1. Local (online)");
    expect(fallbacks).toEqual([expect.objectContaining({ status: 400, code: 40054009 })]);
    await channel.handleMessage(message("m2", "1")); expect(api.sent[1]?.content).toContain("选择项目"); expect(api.sent[1]?.content).toContain("/back"); expect(api.sent[1]?.context).toEqual({ msgId: "m2", msgSeq: 1 });
    await channel.handleMessage(message("m3", "返回")); expect(api.sent[2]?.content).toContain("选择主机");
    await channel.handleMessage(message("m4", "1")); await channel.handleMessage(message("m5", "/刷新")); expect(api.sent.at(-1)?.content).toContain("选择项目"); channel.dispose();
  });
  it("does not treat an out-of-range number as DSH text and ignores duplicate events", async () => {
    const port = new Port(); const api = new Api(); const channel = new QQC2CChannel({ control: new DshControlPlane(port, {}), api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A"] });
    await channel.handleMessage(message("m1", "/computers"));
    await channel.handleMessage(message("m1", "/computers"));
    expect(api.menus).toHaveLength(1);
    await channel.handleMessage(message("m2", "99"));
    expect(port.started).toBe(0);
    expect(api.sent.at(-1)?.content).toContain("无效的菜单选项");
    channel.dispose();
  });
  it("serializes one user while allowing another user to proceed", async () => {
    const port = new Port(); let release = () => undefined; port.gate = new Promise<void>((resolve) => { release = resolve; });
    const api = new Api(); const control = new DshControlPlane(port, {}); const channel = new QQC2CChannel({ control, api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A", "openid-B"] });
    await channel.handleMessage(message("a", "/use computer local"));
    await channel.handleMessage(message("b", "/use project p1"));
    await channel.handleMessage(message("c", "/use session s1"));
    await channel.handleMessage(message("x", "/use computer local", "openid-B"));
    await channel.handleMessage(message("y", "/use project p1", "openid-B"));
    await channel.handleMessage(message("z", "/use session s2", "openid-B"));
    const first = channel.handleMessage(message("d", "hello-a"));
    await flush();
    expect(port.started).toBe(1);
    const secondSame = channel.handleMessage(message("e", "hello-a-2"));
    const other = channel.handleMessage(message("f", "hello-b", "openid-B"));
    await flush();
    expect(port.started).toBe(2);
    release();
    await Promise.all([first, secondSame, other]);
    expect(port.started).toBe(3);
    channel.dispose();
  });
  it("maps direct and external selected-session progress to QQ replies", async () => {
    const port = new Port(); const control = new DshControlPlane(port, {}); const api = new Api(); const channel = new QQC2CChannel({ control, api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A"], progressIntervalMs: 1_000, now: () => 10_000 });
    await channel.handleMessage(message("a", "/use computer local")); await channel.handleMessage(message("b", "/use project p1")); await channel.handleMessage(message("c", "/use session s1")); api.sent.length = 0; api.input.length = 0;
    await channel.handleMessage(message("d", "hello")); expect(api.input).toEqual([1]); expect(api.sent.at(-1)?.content).toBe("reply:hello"); expect(api.sent.at(-1)?.context).toEqual({ msgId: "d", msgSeq: 3 });
    api.sent.length = 0; port.emit({ type: "turn-start", sessionId: "s1", turn: 2 }); port.emit({ type: "turn-end", sessionId: "s1", result: { text: "from GUI", reason: "completed", turn: 2 } }); await flush(); expect(api.sent.at(-1)).toEqual({ user: "openid-A", content: "from GUI", context: {} }); channel.dispose();
  });
  it("splits long replies and stops sending after dispose", async () => {
    const api = new Api();
    const control = {
      handle: async (): Promise<readonly ControlReply[]> => ["好".repeat(3_600)],
      handleCallback: async () => ({ answer: "x" }),
      onSessionProgress: () => () => undefined
    };
    const channel = new QQC2CChannel({ control: control as unknown as DshControlPlane, api: api as unknown as QQOpenApiClient, allowedOpenIds: ["openid-A"] });
    await channel.handleMessage(message("m1", "hello"));
    expect(api.sent).toHaveLength(2);
    expect(api.sent.every((item) => item.content.length <= 1_800)).toBe(true);
    channel.dispose();
    await channel.handleMessage(message("m2", "hello"));
    expect(api.sent).toHaveLength(2);
  });
});

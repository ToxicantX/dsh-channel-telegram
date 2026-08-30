import { describe, expect, it } from "vitest";
import { DshControlPlane } from "./control.js";
import { CallbackTokenStore, type MenuView } from "./menu.js";
import type { AgentPresetSummary, ComputerSummary, DshPort, ProjectSummary, SessionSummary, TurnProgress, TurnProgressListener, TurnResult } from "./ports.js";

class FakePort implements DshPort {
  readonly computers: ComputerSummary[] = [{ id: "local", title: "Local", status: "online" }];
  readonly projects: ProjectSummary[] = [{ id: "p1", title: "Project", path: "C:/p1", status: "online" }];
  readonly sessions: SessionSummary[] = [{ id: "s1", title: "Session", status: "idle" }];
  readonly presets: AgentPresetSummary[] = [{ id: "default", title: "Default", isDefault: true }];
  readonly watchers = new Map<string, Set<TurnProgressListener>>();
  readonly sends: { sessionId: string; text: string }[] = [];
  readonly stops: string[] = [];
  projectLookups = 0;
  computerGate?: Promise<void>;
  sendGate?: Promise<void>;
  sendStarted = false;
  async listComputers() {
    await this.computerGate;
    return this.computers;
  }
  async listProjects() { this.projectLookups += 1; return this.projects; }
  async listSessions() { return this.sessions; }
  async listAgentPresets() { return this.presets; }
  async createSession() { return { id: "s2", title: "New", status: "idle" } as const; }
  async send(sessionId: string, text: string, onProgress?: TurnProgressListener): Promise<TurnResult> {
    this.sends.push({ sessionId, text });
    this.sendStarted = true;
    await this.sendGate;
    onProgress?.({ type: "turn-start", sessionId, turn: 1 });
    const result = { text: "reply:" + text, reason: "completed", turn: 1 } as const;
    onProgress?.({ type: "turn-end", sessionId, result });
    return result;
  }
  async status() { return "idle" as const; }
  async stop(sessionId: string) { this.stops.push(sessionId); return true; }
  watchSession(sessionId: string, listener: TurnProgressListener): () => void {
    let values = this.watchers.get(sessionId);
    if (values === undefined) { values = new Set(); this.watchers.set(sessionId, values); }
    values.add(listener);
    return () => { values?.delete(listener); };
  }
  emit(progress: TurnProgress): void { for (const listener of this.watchers.get(progress.sessionId) ?? []) listener(progress); }
}

const text = (updateId: string, actorId: string, conversationId: string, value: string) => ({ updateId, actorId, conversationId, text: value });
const callback = (updateId: string, actorId: string, conversationId: string, data: string) => ({ updateId, actorId, conversationId, data });
function menu(value: unknown): MenuView { return value as MenuView; }
function tokens(): CallbackTokenStore { let value = 0; return new CallbackTokenStore({ token: () => "t" + String(++value) }); }

describe("DshControlPlane", () => {
  it("reveals target actions progressively and exposes a separate status view", async () => {
    const control = new DshControlPlane(new FakePort(), { callbackStore: tokens() });
    const root = menu((await control.handle(text("1", "openid-A", "c2c-A", "/menu")))[0]);
    expect(root.text).toBe("请选择操作");
    expect(root.rows.flat().map((button) => button.text)).toEqual(["主机", "状态", "刷新"]);

    await control.handle(text("2", "openid-A", "c2c-A", "/use computer local"));
    const withComputer = menu((await control.handle(text("3", "openid-A", "c2c-A", "/menu")))[0]);
    expect(withComputer.rows.flat().map((button) => button.text)).toEqual(["主机", "项目", "状态", "刷新"]);

    await control.handle(text("4", "openid-A", "c2c-A", "/use project p1"));
    const withProject = menu((await control.handle(text("5", "openid-A", "c2c-A", "/menu")))[0]);
    expect(withProject.rows.flat().map((button) => button.text)).toEqual(["主机", "项目", "会话", "新建会话", "状态", "刷新"]);
    const statusData = withProject.rows.flat().find((button) => button.text === "状态")!.callbackData;
    const status = await control.handleCallback(callback("6", "openid-A", "c2c-A", statusData));
    expect(status.answer).toBe("状态");
    expect(status.view?.text).toContain("当前选择");
    expect(status.view?.text).toContain("主机：local");
    expect(status.view?.text).toContain("项目：p1");
    expect(status.view?.rows.flat().map((button) => button.text)).toEqual(["返回", "刷新"]);

    const computers = menu((await control.handle(text("7", "openid-A", "c2c-A", "/computers")))[0]);
    expect(computers.text).toContain("选择主机（第 1/1 页）");
    expect(computers.rows.flat().map((button) => button.text)).toContain("返回");
  });

  it("rejects direct use of a session omitted by the shared archive filter", async () => {
    const port = new FakePort();
    const control = new DshControlPlane(port, {});
    await control.handle(text("1", "openid-A", "c2c-A", "/use computer local"));
    await control.handle(text("2", "openid-A", "c2c-A", "/use project p1"));
    expect(await control.handle(text("3", "openid-A", "c2c-A", "/use session archived-session"))).toEqual(["所选项目中没有此会话。"]);
    expect(await control.handle(text("4", "openid-A", "c2c-A", "hello"))).toEqual(["请从 /menu 选择会话。"]);
    expect(port.sends).toEqual([]);
  });

  it("keeps nonnumeric actors and conversations isolated", async () => {
    const port = new FakePort();
    const control = new DshControlPlane(port, {});
    await control.handle(text("1", "openid-A", "c2c-A", "/use computer local"));
    await control.handle(text("2", "openid-A", "c2c-A", "/use project p1"));
    await control.handle(text("3", "openid-A", "c2c-A", "/use session s1"));
    expect(await control.handle(text("4", "openid-A", "c2c-A", "hello"))).toEqual(["reply:hello"]);
    expect(await control.handle(text("5", "openid-A", "c2c-B", "hello"))).toEqual(["请从 /menu 选择会话。"]);
    expect(await control.handle(text("6", "openid-B", "c2c-A", "hello"))).toEqual(["请从 /menu 选择会话。"]);
  });

  it("binds opaque callbacks to the exact actor and conversation", async () => {
    const control = new DshControlPlane(new FakePort(), { callbackStore: tokens() });
    const computers = menu((await control.handle(text("1", "openid-A", "c2c-A", "/computers")))[0]);
    const data = computers.rows[0]![0]!.callbackData;
    expect((await control.handleCallback(callback("2", "openid-B", "c2c-A", data))).answer).toContain("已过期");
    expect((await control.handleCallback(callback("3", "openid-A", "c2c-B", data))).answer).toContain("已过期");
    expect((await control.handleCallback(callback("4", "openid-A", "c2c-A", data))).answer).toBe("已选择主机。");
  });

  it("rejects expired callback tokens before applying their action", async () => {
    let now = 0;
    let token = 0;
    const store = new CallbackTokenStore({ ttlMs: 100, now: () => now, token: () => "expired-token-" + String(++token) });
    const control = new DshControlPlane(new FakePort(), { callbackStore: store });
    const computers = menu((await control.handle(text("1", "openid-A", "c2c-A", "/computers")))[0]);
    now = 100;
    expect((await control.handleCallback(callback("2", "openid-A", "c2c-A", computers.rows[0]![0]!.callbackData))).answer).toContain("已过期");
  });

  it("relays only the selected session and suppresses the originating direct stream", async () => {
    const port = new FakePort();
    const control = new DshControlPlane(port, {});
    const relayed: string[] = [];
    control.onSessionProgress(({ actorId, conversationId, progress }) => { relayed.push(actorId + ":" + conversationId + ":" + progress.type); });
    await control.handle(text("1", "openid-A", "c2c-A", "/use computer local"));
    await control.handle(text("2", "openid-A", "c2c-A", "/use project p1"));
    await control.handle(text("3", "openid-A", "c2c-A", "/use session s1"));
    port.emit({ type: "turn-start", sessionId: "s1", turn: 9 });
    await Promise.resolve(); await Promise.resolve();
    expect(relayed).toEqual(["openid-A:c2c-A:turn-start"]);
    relayed.length = 0;
    const direct: string[] = [];
    await control.handle(text("4", "openid-A", "c2c-A", "hello"), (progress) => { direct.push(progress.type); });
    await Promise.resolve(); await Promise.resolve();
    expect(direct).toEqual(["queued", "turn-start", "turn-end"]);
    expect(relayed).toEqual([]);
    control.dispose();
  });

  it("scopes idempotency by actor and avoids composite-key collisions", async () => {
    const port = new FakePort();
    const control = new DshControlPlane(port, {});
    await control.handle(text("1", "a:b", "c", "/use computer local"));
    await control.handle(text("2", "a:b", "c", "/use project p1"));
    await control.handle(text("3", "a:b", "c", "/use session s1"));
    expect(await control.handle(text("4", "a", "b:c", "hello"))).toEqual(["请从 /menu 选择会话。"]);

    for (const [actor, id] of [["openid-A", "1"], ["openid-B", "1"]] as const) {
      await control.handle(text(id, actor, "shared", "/use computer local"));
      await control.handle(text("2", actor, "shared", "/use project p1"));
      await control.handle(text("3", actor, "shared", "/use session s1"));
    }
    await control.handle(text("4", "openid-A", "shared", "from A"));
    await control.handle(text("4", "openid-B", "shared", "from B"));
    expect(port.sends.slice(-2)).toEqual([
      { sessionId: "s1", text: "from A" },
      { sessionId: "s1", text: "from B" }
    ]);
  });

  it("serializes selection updates within one conversation", async () => {
    const port = new FakePort();
    let release!: () => void;
    port.computerGate = new Promise<void>((resolve) => { release = resolve; });
    const control = new DshControlPlane(port, {});
    const first = control.handle(text("1", "openid-A", "conversation", "/use computer local"));
    const second = control.handle(text("2", "openid-A", "conversation", "/use project p1"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(port.projectLookups).toBe(0);
    release();
    await expect(first).resolves.toEqual(["已选择主机：local"]);
    await expect(second).resolves.toEqual(["已选择项目：p1"]);
    expect(port.projectLookups).toBe(1);
  });

  it("acknowledges a second message in the same conversation before the active turn finishes", async () => {
    const port = new FakePort(); const control = new DshControlPlane(port, {});
    await control.handle(text("1", "openid-A", "same", "/use computer local"));
    await control.handle(text("2", "openid-A", "same", "/use project p1"));
    await control.handle(text("3", "openid-A", "same", "/use session s1"));
    let release!: () => void; port.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const firstProgress: TurnProgress[] = []; const secondProgress: TurnProgress[] = [];
    const first = control.handle(text("4", "openid-A", "same", "first"), (event) => { firstProgress.push(event); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = control.handle(text("5", "openid-A", "same", "second"), (event) => { secondProgress.push(event); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstProgress[0]).toEqual({ type: "queued", sessionId: "s1", waiting: false });
    expect(secondProgress).toEqual([{ type: "queued", sessionId: "s1", waiting: true }]);
    expect(port.sends).toEqual([{ sessionId: "s1", text: "first" }]);
    release(); await Promise.all([first, second]);
    expect(port.sends).toEqual([{ sessionId: "s1", text: "first" }, { sessionId: "s1", text: "second" }]);
  });

  it("serializes direct turns targeting one session across conversations", async () => {
    const port = new FakePort();
    const control = new DshControlPlane(port, {});
    for (const conversationId of ["c2c-A", "c2c-B"] as const) {
      await control.handle(text("1", "openid-" + conversationId, conversationId, "/use computer local"));
      await control.handle(text("2", "openid-" + conversationId, conversationId, "/use project p1"));
      await control.handle(text("3", "openid-" + conversationId, conversationId, "/use session s1"));
    }
    let release!: () => void;
    port.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const first = control.handle(text("4", "openid-c2c-A", "c2c-A", "first"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = control.handle(text("4", "openid-c2c-B", "c2c-B", "second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(port.sends).toEqual([{ sessionId: "s1", text: "first" }]);
    release();
    await Promise.all([first, second]);
    expect(port.sends).toEqual([
      { sessionId: "s1", text: "first" },
      { sessionId: "s1", text: "second" }
    ]);
  });

  it("keeps stop immediate while a direct turn is running", async () => {
    const port = new FakePort();
    const control = new DshControlPlane(port, {});
    await control.handle(text("1", "openid-A", "c2c-A", "/use computer local"));
    await control.handle(text("2", "openid-A", "c2c-A", "/use project p1"));
    await control.handle(text("3", "openid-A", "c2c-A", "/use session s1"));
    let release!: () => void;
    port.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const request = control.handle(text("4", "openid-A", "c2c-A", "hello"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(port.sendStarted).toBe(true);
    expect(await control.handle(text("5", "openid-A", "c2c-A", "/stop"))).toEqual(["已请求停止；排队中的工作已保留。"]);
    expect(port.stops).toEqual(["s1"]);
    release();
    await expect(request).resolves.toEqual(["reply:hello"]);
  });

  it("drops progress from a session after the conversation selects another", async () => {
    const port = new FakePort();
    port.sessions.push({ id: "s2", title: "Other", status: "idle" });
    const control = new DshControlPlane(port, {});
    const relayed: string[] = [];
    control.onSessionProgress(({ progress }) => { relayed.push(progress.sessionId + ":" + progress.type); });
    await control.handle(text("1", "openid-A", "c2c-A", "/use computer local"));
    await control.handle(text("2", "openid-A", "c2c-A", "/use project p1"));
    await control.handle(text("3", "openid-A", "c2c-A", "/use session s1"));
    await control.handle(text("4", "openid-A", "c2c-A", "/use session s2"));
    port.emit({ type: "turn-start", sessionId: "s1", turn: 1 });
    port.emit({ type: "turn-start", sessionId: "s2", turn: 2 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relayed).toEqual(["s2:turn-start"]);
    expect(port.watchers.get("s1")?.size ?? 0).toBe(0);
  });

  it("rejects new work and clears watches after dispose", async () => {
    const port = new FakePort();
    const control = new DshControlPlane(port, {});
    let disposeCount = 0;
    control.onDispose(() => { disposeCount += 1; });
    await control.handle(text("1", "openid-A", "c2c-A", "/use computer local"));
    await control.handle(text("2", "openid-A", "c2c-A", "/use project p1"));
    await control.handle(text("3", "openid-A", "c2c-A", "/use session s1"));
    expect(port.watchers.get("s1")?.size).toBe(1);
    control.dispose();
    control.dispose();
    expect(disposeCount).toBe(1);
    expect(port.watchers.get("s1")?.size ?? 0).toBe(0);
    expect(await control.handle(text("4", "openid-A", "c2c-A", "/menu"))).toEqual([]);
    expect((await control.handleCallback(callback("5", "openid-A", "c2c-A", "m:missing"))).answer).toContain("已过期");
  });
});

import { describe, expect, it } from "vitest";
import { TelegramGateway } from "./gateway.js";
import { CallbackTokenStore, type MenuView } from "./menu.js";
import type { AgentPresetSummary, ComputerSummary, DshPort, ProjectSummary, SessionSummary, TurnProgress, TurnProgressListener, TurnResult } from "./ports.js";

class FakePort implements DshPort {
  computers: ComputerSummary[] = [{ id: "local", title: "Local DSH", status: "online" }];
  projects: ProjectSummary[] = [{ id: "p1", title: "Project", path: "C:/project", status: "online" }];
  sessions: SessionSummary[] = [{ id: "s1", title: "Session", status: "idle" }];
  presets: AgentPresetSummary[] = [
    { id: "default", title: "Default agent", isDefault: true },
    { id: "coder", title: "Coder", description: "Writes code", isDefault: false }
  ];
  sends: { sessionId: string; text: string }[] = [];
  creates: { computerId: string; projectId: string; agentPresetId: string }[] = [];
  watches = new Map<string, Set<TurnProgressListener>>();
  failure?: Error;
  async listComputers() { return this.computers; }
  async listProjects() { return this.projects; }
  async listSessions() { return this.sessions; }
  async listAgentPresets() { return this.presets; }
  async createSession(computerId: string, projectId: string, agentPresetId: string) {
    this.creates.push({ computerId, projectId, agentPresetId });
    const session = { id: "s2", title: "New session", status: "idle" } as const;
    this.sessions = [...this.sessions, session];
    return session;
  }
  async send(sessionId: string, text: string, onProgress?: TurnProgressListener): Promise<TurnResult> {
    this.sends.push({ sessionId, text });
    if (this.failure !== undefined) throw this.failure;
    onProgress?.({ type: "turn-start", sessionId, turn: 1 });
    this.emitWatch(sessionId, { type: "turn-start", sessionId, turn: 1 });
    onProgress?.({ type: "assistant-delta", sessionId, turn: 1, step: 1, text: "reply:" + text });
    this.emitWatch(sessionId, { type: "assistant-delta", sessionId, turn: 1, step: 1, text: "reply:" + text });
    const result = { text: "reply:" + text, reason: "completed", turn: 1 } as const;
    onProgress?.({ type: "turn-end", sessionId, result });
    this.emitWatch(sessionId, { type: "turn-end", sessionId, result });
    return result;
  }
  async status() { return "idle" as const; }
  async stop() { return true; }
  watchSession(sessionId: string, listener: TurnProgressListener): () => void {
    let set = this.watches.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.watches.set(sessionId, set);
    }
    set.add(listener);
    return () => { set!.delete(listener); };
  }
  emitWatch(sessionId: string, progress: TurnProgress): void {
    const set = this.watches.get(sessionId);
    if (set === undefined) return;
    for (const listener of [...set]) listener(progress);
  }
}

const update = (updateId: number, text: string, overrides: Partial<Parameters<TelegramGateway["handle"]>[0]> = {}) => ({
  updateId, chatId: 10, chatType: "private", userId: 42, text, ...overrides
});
const callback = (updateId: number, data: string, overrides: Partial<Parameters<TelegramGateway["handleCallback"]>[0]> = {}) => ({
  updateId, chatId: 10, chatType: "private", userId: 42, data, ...overrides
});
function menu(value: unknown): MenuView {
  expect(value).toEqual(expect.objectContaining({ text: expect.any(String), rows: expect.any(Array) }));
  return value as MenuView;
}

function tokens() {
  let next = 0;
  return new CallbackTokenStore({ token: () => "token" + String(++next) });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TelegramGateway", () => {
  it("silently rejects groups and users outside the numeric allowlist", async () => {
    const gateway = new TelegramGateway(new FakePort(), { allowedUserIds: [42] });
    expect(await gateway.handle(update(1, "/projects", { chatType: "group" }))).toEqual([]);
    expect(await gateway.handle(update(2, "/projects", { userId: 7 }))).toEqual([]);
  });

  it("selects computer, project, and session through opaque inline menus", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42], callbackStore: tokens() });
    const computers = menu((await gateway.handle(update(1, "/computers")))[0]);
    const computerData = computers.rows[0]![0]!.callbackData;
    expect(computerData).not.toContain("local");
    expect(computerData.length).toBeLessThanOrEqual(64);

    const projectsResult = await gateway.handleCallback(callback(2, computerData));
    const projects = menu(projectsResult.view);
    const sessionsResult = await gateway.handleCallback(callback(3, projects.rows[0]![0]!.callbackData));
    const sessions = menu(sessionsResult.view);
    const selected = await gateway.handleCallback(callback(4, sessions.rows[0]![0]!.callbackData));
    expect(selected.answer).toBe("已选择会话。");
    expect(selected.view?.text).toContain("会话：s1");

    const progress: string[] = [];
    expect(await gateway.handle(update(5, "hello"), (event) => { progress.push(event.type); })).toEqual([]);
    expect(port.sends).toEqual([{ sessionId: "s1", text: "hello" }]);
    expect(progress).toEqual(["queued", "turn-start", "assistant-delta", "turn-end"]);
  });

  it("preserves text selection commands and routes only to the selected session", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    expect(await gateway.handle(update(1, "/use computer local"))).toEqual(["已选择主机：local"]);
    expect(await gateway.handle(update(2, "/use project p1"))).toEqual(["已选择项目：p1"]);
    expect(await gateway.handle(update(3, "/use session s1"))).toEqual(["已选择会话：s1"]);
    expect(await gateway.handle(update(4, "hello"))).toEqual(["reply:hello"]);
    expect(port.sends).toEqual([{ sessionId: "s1", text: "hello" }]);
  });

  it("paginates target lists", async () => {
    const port = new FakePort();
    port.projects = [1, 2, 3].map((id) => ({ id: "p" + String(id), title: "Project " + String(id), path: "C:/p" + String(id), status: "online" }));
    const gateway = new TelegramGateway(port, { allowedUserIds: [42], pageSize: 2, callbackStore: tokens() });
    const computers = menu((await gateway.handle(update(1, "/computers")))[0]);
    const firstPage = menu((await gateway.handleCallback(callback(2, computers.rows[0]![0]!.callbackData))).view);
    expect(firstPage.text).toContain("1/2");
    const next = firstPage.rows.flat().find((button) => button.text === "下一页");
    const secondPage = menu((await gateway.handleCallback(callback(3, next!.callbackData))).view);
    expect(secondPage.text).toContain("2/2");
    expect(secondPage.rows.flat().some((button) => button.text.includes("Project 3"))).toBe(true);
  });

  it("rejects stale hierarchy callbacks after the computer changes", async () => {
    const port = new FakePort();
    port.computers.push({ id: "remote", title: "Remote", status: "online" });
    const gateway = new TelegramGateway(port, { allowedUserIds: [42], callbackStore: tokens() });
    const firstComputers = menu((await gateway.handle(update(1, "/computers")))[0]);
    const localProjects = menu((await gateway.handleCallback(callback(2, firstComputers.rows[0]![0]!.callbackData))).view);
    const staleProject = localProjects.rows[0]![0]!.callbackData;
    const secondComputers = menu((await gateway.handle(update(3, "/computers")))[0]);
    await gateway.handleCallback(callback(4, secondComputers.rows[1]![0]!.callbackData));
    expect((await gateway.handleCallback(callback(5, staleProject))).answer).toBe("所选主机已变更。");
  });

  it("finalizes the Telegram progress stream when DSH rejects the request", async () => {
    const port = new FakePort();
    port.failure = new Error("resume failed");
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    await gateway.handle(update(3, "/use session s1"));
    const progress: string[] = [];
    expect(await gateway.handle(update(4, "fail"), (event) => { progress.push(event.type); })).toEqual([]);
    expect(progress).toEqual(["queued", "failed"]);
  });

  it("suppresses duplicate Telegram updates before execution", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    await gateway.handle(update(3, "/use session s1"));
    await gateway.handle(update(4, "once"));
    expect(await gateway.handle(update(4, "once"))).toEqual([]);
    expect(port.sends).toHaveLength(1);
  });

  it("requires computer and project then returns a paginated preset menu for /new", async () => {
    const port = new FakePort();
    port.presets = [1, 2, 3].map((id) => ({ id: "preset" + String(id), title: "Preset " + String(id), isDefault: id === 1 }));
    const gateway = new TelegramGateway(port, { allowedUserIds: [42], pageSize: 2, callbackStore: tokens() });
    expect(await gateway.handle(update(1, "/new"))).toEqual(["请先选择主机和项目。"]);
    await gateway.handle(update(2, "/use computer local"));
    await gateway.handle(update(3, "/use project p1"));
    const firstPage = menu((await gateway.handle(update(4, "/new")))[0]);
    expect(firstPage.text).toContain("选择 Agent 预设");
    expect(firstPage.text).toContain("1/2");
    expect(firstPage.rows.flat().some((button) => button.text.startsWith("* Preset 1"))).toBe(true);
    expect(port.creates).toEqual([]);
    const next = firstPage.rows.flat().find((button) => button.text === "下一页");
    const secondPage = menu((await gateway.handleCallback(callback(5, next!.callbackData))).view);
    expect(secondPage.text).toContain("2/2");
    expect(secondPage.rows.flat().some((button) => button.text.includes("Preset 3"))).toBe(true);
  });

  it("shows an explicit state when no Agent preset is available", async () => {
    const port = new FakePort();
    port.presets = [];
    const gateway = new TelegramGateway(port, { allowedUserIds: [42], callbackStore: tokens() });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    const presets = menu((await gateway.handle(update(3, "/new")))[0]);
    expect(presets.text).toBe("没有可用的 Agent 预设。");
    expect(presets.rows.flat().map((button) => button.text)).toEqual(["返回", "刷新"]);
    expect(port.creates).toEqual([]);
  });

  it("creates a session from a still-available preset and returns the root menu", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42], callbackStore: tokens() });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    const presets = menu((await gateway.handle(update(3, "/new")))[0]);
    const defaultButton = presets.rows.flat().find((button) => button.text.startsWith("* Default agent"));
    expect(defaultButton).toBeDefined();
    const created = await gateway.handleCallback(callback(4, defaultButton!.callbackData));
    expect(created.answer).toBe("会话已创建。");
    expect(created.view?.text).toContain("会话：s2");
    expect(port.creates).toEqual([{ computerId: "local", projectId: "p1", agentPresetId: "default" }]);
  });

  it("rejects stale preset callbacks after the project or roster changes", async () => {
    const port = new FakePort();
    port.projects.push({ id: "p2", title: "Other", path: "C:/other", status: "online" });
    const gateway = new TelegramGateway(port, { allowedUserIds: [42], callbackStore: tokens() });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    const presets = menu((await gateway.handle(update(3, "/new")))[0]);
    const staleCreate = presets.rows[0]![0]!.callbackData;
    await gateway.handle(update(4, "/use project p2"));
    expect((await gateway.handleCallback(callback(5, staleCreate))).answer).toBe("所选项目已变更。");

    await gateway.handle(update(6, "/use project p1"));
    const laterPresets = menu((await gateway.handle(update(7, "/new")))[0]);
    const goneCreate = laterPresets.rows[1]![0]!.callbackData;
    port.presets = port.presets.filter((item) => item.id !== "coder");
    expect((await gateway.handleCallback(callback(8, goneCreate))).answer).toBe("Agent 预设已不可用。");
    expect(port.creates).toEqual([]);
  });

  it("relays selected external session progress to the matching user and chat", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    const events: { userId: number; chatId: number; type: string }[] = [];
    gateway.onSessionProgress((event) => { events.push({ userId: event.userId, chatId: event.chatId, type: event.progress.type }); });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    await gateway.handle(update(3, "/use session s1"));
    port.emitWatch("s1", { type: "turn-start", sessionId: "s1", turn: 9 });
    await flush();
    expect(events).toEqual([{ userId: 42, chatId: 10, type: "turn-start" }]);
  });

  it("stops relaying old events after the selected session changes", async () => {
    const port = new FakePort();
    port.sessions.push({ id: "s3", title: "Other session", status: "idle" });
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    const events: string[] = [];
    gateway.onSessionProgress((event) => { events.push(event.progress.sessionId + ":" + event.progress.type); });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    await gateway.handle(update(3, "/use session s1"));
    await gateway.handle(update(4, "/use session s3"));
    port.emitWatch("s1", { type: "turn-start", sessionId: "s1", turn: 1 });
    port.emitWatch("s3", { type: "turn-start", sessionId: "s3", turn: 2 });
    await flush();
    expect(events).toEqual(["s3:turn-start"]);
    expect(port.watches.get("s1")?.size ?? 0).toBe(0);
  });

  it("does not duplicate the originating chat watch while another chat can receive it", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    const relay: { chatId: number; type: string }[] = [];
    gateway.onSessionProgress((event) => { relay.push({ chatId: event.chatId, type: event.progress.type }); });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    await gateway.handle(update(3, "/use session s1"));
    await gateway.handle(update(4, "/use computer local", { chatId: 11, updateId: 11 }));
    await gateway.handle(update(5, "/use project p1", { chatId: 11, updateId: 12 }));
    await gateway.handle(update(6, "/use session s1", { chatId: 11, updateId: 13 }));

    const direct: string[] = [];
    expect(await gateway.handle(update(7, "hello"), (event) => { direct.push(event.type); })).toEqual([]);
    await flush();
    expect(direct).toEqual(["queued", "turn-start", "assistant-delta", "turn-end"]);
    expect(relay.every((event) => event.chatId === 11)).toBe(true);
    expect(relay.map((event) => event.type)).toEqual(["turn-start", "assistant-delta", "turn-end"]);
  });

  it("disposes watches and session listeners", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    const events: string[] = [];
    const unsubscribe = gateway.onSessionProgress((event) => { events.push(event.progress.type); });
    await gateway.handle(update(1, "/use computer local"));
    await gateway.handle(update(2, "/use project p1"));
    await gateway.handle(update(3, "/use session s1"));
    expect(port.watches.get("s1")?.size).toBe(1);
    unsubscribe();
    port.emitWatch("s1", { type: "turn-start", sessionId: "s1", turn: 1 });
    await flush();
    expect(events).toEqual([]);
    gateway.dispose();
    expect(port.watches.get("s1")?.size ?? 0).toBe(0);
    port.emitWatch("s1", { type: "turn-start", sessionId: "s1", turn: 2 });
    await flush();
    expect(events).toEqual([]);
  });

  it("keeps the private numeric allowlist after control disposal", async () => {
    const gateway = new TelegramGateway(new FakePort(), { allowedUserIds: [42] });
    expect(await gateway.handle(update(1, "/menu"))).toHaveLength(1);
    gateway.dispose();
    expect(await gateway.handle(update(2, "/menu"))).toEqual([]);
    expect(await gateway.handleCallback(callback(3, "m:missing"))).toEqual({ answer: "菜单已过期，请重新发送 /menu。" });
  });
});

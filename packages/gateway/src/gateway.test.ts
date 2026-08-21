import { describe, expect, it } from "vitest";
import { TelegramGateway } from "./gateway.js";
import { CallbackTokenStore, type MenuView } from "./menu.js";
import type { ComputerSummary, DshPort, ProjectSummary, SessionSummary, TurnProgressListener, TurnResult } from "./ports.js";

class FakePort implements DshPort {
  computers: ComputerSummary[] = [{ id: "local", title: "Local DSH", status: "online" }];
  projects: ProjectSummary[] = [{ id: "p1", title: "Project", path: "C:/project", status: "online" }];
  sessions: SessionSummary[] = [{ id: "s1", title: "Session", status: "idle" }];
  sends: { sessionId: string; text: string }[] = [];
  failure?: Error;
  async listComputers() { return this.computers; }
  async listProjects() { return this.projects; }
  async listSessions() { return this.sessions; }
  async createSession() { return { id: "s2", title: "New session", status: "idle" } as const; }
  async send(sessionId: string, text: string, onProgress?: TurnProgressListener): Promise<TurnResult> {
    this.sends.push({ sessionId, text });
    if (this.failure !== undefined) throw this.failure;
    onProgress?.({ type: "turn-start", sessionId, turn: 1 });
    onProgress?.({ type: "assistant-delta", sessionId, turn: 1, step: 1, text: "reply:" + text });
    const result = { text: "reply:" + text, reason: "completed", turn: 1 } as const;
    onProgress?.({ type: "turn-end", sessionId, result });
    return result;
  }
  async status() { return "idle" as const; }
  async stop() { return true; }
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
    expect(selected.answer).toBe("Session selected.");
    expect(selected.view?.text).toContain("Session: s1");

    const progress: string[] = [];
    expect(await gateway.handle(update(5, "hello"), (event) => { progress.push(event.type); })).toEqual([]);
    expect(port.sends).toEqual([{ sessionId: "s1", text: "hello" }]);
    expect(progress).toEqual(["queued", "turn-start", "assistant-delta", "turn-end"]);
  });

  it("preserves text selection commands and routes only to the selected session", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    expect(await gateway.handle(update(1, "/use computer local"))).toEqual(["Computer selected: local"]);
    expect(await gateway.handle(update(2, "/use project p1"))).toEqual(["Project selected: p1"]);
    expect(await gateway.handle(update(3, "/use session s1"))).toEqual(["Session selected: s1"]);
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
    const next = firstPage.rows.flat().find((button) => button.text === "Next");
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
    expect((await gateway.handleCallback(callback(5, staleProject))).answer).toBe("Computer selection changed.");
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
});

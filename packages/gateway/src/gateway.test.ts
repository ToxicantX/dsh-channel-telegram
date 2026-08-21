import { describe, expect, it } from "vitest";
import { TelegramGateway } from "./gateway.js";
import type { DshPort, ProjectSummary, SessionSummary, TurnResult } from "./ports.js";

class FakePort implements DshPort {
  projects: ProjectSummary[] = [{ id: "p1", title: "Project", path: "C:/project", status: "online" }];
  sessions: SessionSummary[] = [{ id: "s1", title: "Session", status: "idle" }];
  sends: string[] = [];
  async listProjects() { return this.projects; }
  async listSessions() { return this.sessions; }
  async createSession() { return { id: "s2", title: "New session", status: "idle" } as const; }
  async send(_sessionId: string, text: string): Promise<TurnResult> { this.sends.push(text); return { text: `reply:${text}`, reason: "completed", turn: 1 }; }
  async status() { return "idle" as const; }
  async stop() { return true; }
}

const update = (updateId: number, text: string, overrides: Partial<Parameters<TelegramGateway["handle"]>[0]> = {}) => ({
  updateId, chatId: 10, chatType: "private", userId: 42, text, ...overrides
});

describe("TelegramGateway", () => {
  it("silently rejects groups and users outside the numeric allowlist", async () => {
    const gateway = new TelegramGateway(new FakePort(), { allowedUserIds: [42] });
    expect(await gateway.handle(update(1, "/projects", { chatType: "group" }))).toEqual([]);
    expect(await gateway.handle(update(2, "/projects", { userId: 7 }))).toEqual([]);
  });

  it("selects a project and session before routing text", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    expect(await gateway.handle(update(1, "/use project p1"))).toEqual(["Project selected: p1"]);
    expect(await gateway.handle(update(2, "/use session s1"))).toEqual(["Session selected: s1"]);
    expect(await gateway.handle(update(3, "hello"))).toEqual(["reply:hello"]);
    expect(port.sends).toEqual(["hello"]);
  });

  it("suppresses duplicate Telegram updates before execution", async () => {
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    await gateway.handle(update(1, "/use project p1"));
    await gateway.handle(update(2, "/use session s1"));
    await gateway.handle(update(3, "once"));
    expect(await gateway.handle(update(3, "once"))).toEqual([]);
    expect(port.sends).toEqual(["once"]);
  });
});

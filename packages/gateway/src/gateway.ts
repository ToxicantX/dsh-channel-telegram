import type { DshPort, TelegramTextUpdate } from "./ports.js";
import { BoundedIdSet, KeyedSerialQueue } from "./queue.js";

interface Selection {
  projectId?: string;
  sessionId?: string;
}

export interface GatewayOptions {
  readonly allowedUserIds: readonly number[];
  readonly idempotencyCapacity?: number;
}

export class TelegramGateway {
  private readonly allowed: Set<number>;
  private readonly seen: BoundedIdSet;
  private readonly queues = new KeyedSerialQueue();
  private readonly selections = new Map<number, Selection>();

  constructor(private readonly dsh: DshPort, options: GatewayOptions) {
    if (options.allowedUserIds.length === 0) throw new Error("allowedUserIds must not be empty");
    if (options.allowedUserIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("allowedUserIds must contain positive integers");
    this.allowed = new Set(options.allowedUserIds);
    this.seen = new BoundedIdSet(options.idempotencyCapacity);
  }

  async handle(update: TelegramTextUpdate): Promise<readonly string[]> {
    if (update.chatType !== "private" || !this.allowed.has(update.userId)) return [];
    if (!this.seen.addIfNew(`${update.chatId}:${update.updateId}`)) return [];
    const text = update.text.trim();
    if (text === "") return [];
    if (!text.startsWith("/")) return [await this.sendText(update.userId, text)];

    const [rawCommand = "", ...args] = text.split(/\s+/u);
    const command = rawCommand.split("@", 1)[0]?.toLowerCase();
    switch (command) {
      case "/computers": return ["local | online"];
      case "/projects": return [await this.projects()];
      case "/sessions": return [await this.sessions(update.userId, args[0])];
      case "/use": return [await this.use(update.userId, args)];
      case "/new": return [await this.create(update.userId, args[0])];
      case "/status": return [await this.status(update.userId)];
      case "/stop": return [await this.stop(update.userId)];
      default: return ["Commands: /computers /projects /sessions /use /new /status /stop"];
    }
  }

  private selection(userId: number): Selection {
    let value = this.selections.get(userId);
    if (value === undefined) {
      value = {};
      this.selections.set(userId, value);
    }
    return value;
  }

  private async projects(): Promise<string> {
    const projects = await this.dsh.listProjects();
    if (projects.length === 0) return "No projects.";
    return projects.map((project) => `${project.id} | ${project.title} | ${project.status} | ${project.path}`).join("\n");
  }

  private async sessions(userId: number, explicitProject?: string): Promise<string> {
    const projectId = explicitProject ?? this.selection(userId).projectId;
    if (projectId === undefined) return "Select a project with /use project <id>.";
    const sessions = await this.dsh.listSessions(projectId);
    if (sessions.length === 0) return "No sessions.";
    return sessions.map((session) => `${session.id} | ${session.title} | ${session.status}`).join("\n");
  }

  private async use(userId: number, args: readonly string[]): Promise<string> {
    const [kind, id] = args;
    if ((kind !== "project" && kind !== "session") || id === undefined) return "Usage: /use project <id> or /use session <id>.";
    const selected = this.selection(userId);
    if (kind === "project") {
      const exists = (await this.dsh.listProjects()).some((project) => project.id === id);
      if (!exists) return "Unknown project.";
      selected.projectId = id;
      selected.sessionId = undefined;
      return `Project selected: ${id}`;
    }
    if (selected.projectId === undefined) return "Select a project first.";
    const exists = (await this.dsh.listSessions(selected.projectId)).some((session) => session.id === id);
    if (!exists) return "Unknown session for the selected project.";
    selected.sessionId = id;
    return `Session selected: ${id}`;
  }

  private async create(userId: number, explicitProject?: string): Promise<string> {
    const selected = this.selection(userId);
    const projectId = explicitProject ?? selected.projectId;
    if (projectId === undefined) return "Select a project first.";
    const session = await this.dsh.createSession(projectId);
    selected.projectId = projectId;
    selected.sessionId = session.id;
    return `Session created and selected: ${session.id}`;
  }

  private async status(userId: number): Promise<string> {
    const selected = this.selection(userId);
    if (selected.sessionId === undefined) return "No session selected.";
    return `NaN`;
  }

  private async stop(userId: number): Promise<string> {
    const sessionId = this.selection(userId).sessionId;
    if (sessionId === undefined) return "No session selected.";
    return (await this.dsh.stop(sessionId)) ? "Stop requested; queued work was preserved." : "No live turn to stop.";
  }

  private async sendText(userId: number, text: string): Promise<string> {
    const sessionId = this.selection(userId).sessionId;
    if (sessionId === undefined) return "Select a session with /use session <id>.";
    const result = await this.queues.run(sessionId, () => this.dsh.send(sessionId, text));
    if (result.text !== "") return result.text;
    return `Turn ${result.turn} ended: ${result.reason}.`;
  }
}

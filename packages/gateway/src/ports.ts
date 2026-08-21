export interface ProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly status: "online" | "missing";
}

export interface SessionSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "idle" | "running" | "offline";
}

export interface TurnResult {
  readonly text: string;
  readonly reason: "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted";
  readonly turn: number;
}

export interface DshPort {
  listProjects(): Promise<readonly ProjectSummary[]>;
  listSessions(projectId: string): Promise<readonly SessionSummary[]>;
  createSession(projectId: string): Promise<SessionSummary>;
  send(sessionId: string, text: string): Promise<TurnResult>;
  status(sessionId: string): Promise<SessionSummary["status"]>;
  stop(sessionId: string): Promise<boolean>;
}

export interface TelegramTextUpdate {
  readonly updateId: number;
  readonly chatId: number;
  readonly chatType: string;
  readonly userId: number;
  readonly text: string;
}

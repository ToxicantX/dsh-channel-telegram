export interface ComputerSummary {
  readonly id: string;
  readonly title: string;
  readonly status: "online" | "offline";
}

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

export interface AgentPresetSummary {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly isDefault: boolean;
}

export interface TurnResult {
  readonly text: string;
  readonly reason: "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted";
  readonly turn: number;
}

/** Downloaded inbound media ready for the DSH attachment admission boundary. */
export type DshInboundAttachment =
  | { readonly type: "image"; readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }
  | { readonly type: "file"; readonly data: Uint8Array; readonly mediaType: string; readonly name?: string };

export type TurnProgress =
  /** Accepted as a next-turn follow-up; waiting means earlier work already owns the session FIFO. */
  | { readonly type: "queued"; readonly sessionId: string; readonly waiting: boolean }
  | { readonly type: "turn-start"; readonly sessionId: string; readonly turn: number }
  | { readonly type: "assistant-delta"; readonly sessionId: string; readonly turn: number; readonly step: number; readonly text: string }
  | { readonly type: "assistant-message"; readonly sessionId: string; readonly turn: number; readonly step: number; readonly text: string }
  | { readonly type: "tool-start"; readonly sessionId: string; readonly turn: number; readonly step: number; readonly callId: string; readonly name: string }
  | { readonly type: "tool-end"; readonly sessionId: string; readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly failed: boolean }
  | { readonly type: "turn-end"; readonly sessionId: string; readonly result: TurnResult }
  | { readonly type: "failed"; readonly sessionId: string; readonly message: string };

export type TurnProgressListener = (progress: TurnProgress) => void;

export interface DshPort {
  listComputers(): Promise<readonly ComputerSummary[]>;
  listProjects(computerId: string): Promise<readonly ProjectSummary[]>;
  listSessions(computerId: string, projectId: string): Promise<readonly SessionSummary[]>;
  listAgentPresets(): Promise<readonly AgentPresetSummary[]>;
  createSession(computerId: string, projectId: string, agentPresetId: string): Promise<SessionSummary>;
  /** Submit one ordinary follow-up as its own next turn; it never steers or interrupts active work. */
  send(sessionId: string, text: string, onProgress?: TurnProgressListener, attachments?: readonly DshInboundAttachment[]): Promise<TurnResult>;
  status(sessionId: string): Promise<SessionSummary["status"]>;
  stop(sessionId: string): Promise<boolean>;
  watchSession(sessionId: string, listener: TurnProgressListener): () => void;
}

export interface TelegramTextUpdate {
  readonly updateId: number;
  readonly chatId: number;
  readonly chatType: string;
  readonly userId: number;
  readonly text: string;
  readonly attachments?: readonly DshInboundAttachment[];
}

export interface TelegramCallbackUpdate {
  readonly updateId: number;
  readonly chatId: number;
  readonly chatType: string;
  readonly userId: number;
  readonly data: string;
}

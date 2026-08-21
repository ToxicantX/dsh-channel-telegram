import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import type { DshPort, ProjectSummary, SessionSummary, TurnResult } from "@dsh-channel-telegram/gateway";

export interface DshAdapterOptions {
  readonly turnTimeoutMs: number;
  readonly agentPreset?: string;
}

export class CorrelatedTurnCollector {
  private openTurn?: number;
  private targetTurn?: number;
  private text = "";

  constructor(private readonly messageId: string) {}

  accept(event: SessionEvent): TurnResult | undefined {
    if (event.type === "turn/start") this.openTurn = event.data.turn;
    if (event.type === "user/message" && String(event.data.id) === this.messageId) this.targetTurn = this.openTurn;
    if (event.type === "assistant/message" && event.data.turn === this.targetTurn) {
      this.text = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
    if (event.type !== "turn/end" || event.data.turn !== this.targetTurn) return undefined;
    return {
      text: this.text || errorText(event.data.reason),
      reason: event.data.reason.kind,
      turn: event.data.turn
    };
  }
}

function errorText(reason: TurnEndReason): string {
  return reason.kind === "error" ? `DSH error: ${reason.error.message}` : "";
}

export class DshAdapter implements DshPort {
  private readonly handles = new Map<string, AgentHandle>();

  constructor(private readonly ctx: Context, private readonly options: DshAdapterOptions) {
    if (!Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs < 1) throw new Error("turnTimeoutMs must be a positive integer");
  }

  async listProjects(): Promise<readonly ProjectSummary[]> {
    return Promise.all(this.ctx.workspaceRegistry.list().map(async (workspace) => ({
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
      status: (await workspace.status()) === "ok" ? "online" as const : "missing" as const
    })));
  }

  async listSessions(projectId: string): Promise<readonly SessionSummary[]> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(projectId));
    if (workspace === undefined) throw new Error("Unknown workspace");
    return Promise.all(workspace.sessionIds.map(async (sessionId) => {
      const title = await this.ctx.sessionQuery.readTitle(sessionId);
      return {
        id: String(sessionId),
        title: title?.title ?? String(sessionId),
        status: this.liveStatus(String(sessionId))
      };
    }));
  }

  async createSession(projectId: string): Promise<SessionSummary> {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(projectId));
    if (workspace === undefined) throw new Error("Unknown workspace");
    if ((await workspace.status()) !== "ok") throw new Error("Workspace directory is missing");
    const selection = this.ctx.agentDefaultModel.currentSelection();
    const presetId = this.options.agentPreset ?? this.ctx.agentPresets.defaultId;
    const sessionId = SessionId(`session-${randomUUID()}`);
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: presetId },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, presetId);
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      }
    });
    this.handles.set(String(sessionId), handle);
    await workspace.attachSession(sessionId);
    return { id: String(sessionId), title: String(sessionId), status: handle.agent.status };
  }

  async send(sessionId: string, text: string): Promise<TurnResult> {
    const agent = await this.ensureAgent(sessionId);
    const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    const collector = new CorrelatedTurnCollector(String(message.id));
    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      const dispose = this.ctx.on("session/event", (session, event) => {
        if (String(session.id) !== sessionId) return;
        const result = collector.accept(event);
        if (result === undefined || settled) return;
        settled = true;
        clearTimeout(timer);
        dispose();
        resolve(result);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        dispose();
        reject(new Error(`Timed out waiting for session ${sessionId}`));
      }, this.options.turnTimeoutMs);
      try {
        agent.followup(message);
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        dispose();
        reject(error);
      }
    });
  }

  async status(sessionId: string): Promise<SessionSummary["status"]> {
    return this.liveStatus(sessionId);
  }

  async stop(sessionId: string): Promise<boolean> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined || agent.status !== "running") return false;
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return true;
  }

  async dispose(): Promise<void> {
    const handles = [...this.handles.values()].reverse();
    this.handles.clear();
    await Promise.allSettled(handles.map((handle) => handle.dispose()));
  }

  private liveStatus(sessionId: string): SessionSummary["status"] {
    return this.ctx.agents.get(SessionId(sessionId))?.status ?? "offline";
  }

  private async ensureAgent(rawSessionId: string): Promise<Agent> {
    const sessionId = SessionId(rawSessionId);
    const existing = this.ctx.agents.get(sessionId);
    if (existing !== undefined) return existing;
    const snapshot = await this.ctx.sessionQuery.readSession(sessionId);
    const presetId = resolveSessionPreset({ header: snapshot.session, events: snapshot.events });
    const selection = this.ctx.agentDefaultModel.currentSelection();
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        if (presetId !== undefined) await this.ctx.agentPresets.mount(agentCtx, presetId);
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      }
    });
    this.handles.set(rawSessionId, handle);
    return handle.agent;
  }
}

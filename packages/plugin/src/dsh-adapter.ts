import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type Agent, type AgentHandle } from "@deepseek-ai/dsh-agent";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent, type TurnEndReason } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-query";
import { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import type { AgentPresetSummary, ComputerSummary, DshPort, ProjectSummary, SessionSummary, TurnProgress, TurnProgressListener, TurnResult } from "@wsxcant/dsh-channel-telegram-gateway";

export interface DshAdapterOptions {
  readonly turnTimeoutMs: number;
  readonly hostName: string;
}

export interface CollectorUpdate {
  readonly progress?: TurnProgress;
  readonly result?: TurnResult;
}

export class CorrelatedTurnCollector {
  private openTurn?: number;
  private targetTurn?: number;
  private text = "";
  private readonly tools = new Map<string, string>();

  constructor(private readonly messageId: string, private readonly sessionId = "session") {}

  accept(event: SessionEvent): CollectorUpdate {
    if (event.type === "turn/start") {
      this.openTurn = event.data.turn;
      return {};
    }
    if (event.type === "user/message" && String(event.data.id) === this.messageId) {
      this.targetTurn = this.openTurn;
      return this.targetTurn === undefined ? {} : { progress: { type: "turn-start", sessionId: this.sessionId, turn: this.targetTurn } };
    }
    if (this.targetTurn === undefined) return {};
    if (event.type === "assistant/chunk" && event.data.turn === this.targetTurn && event.data.chunk.type === "text-delta" && event.data.chunk.text !== "") {
      return { progress: { type: "assistant-delta", sessionId: this.sessionId, turn: this.targetTurn, step: event.data.step, text: event.data.chunk.text } };
    }
    if (event.type === "assistant/message" && event.data.turn === this.targetTurn) {
      this.text = visibleText(event.data.message.content);
      return { progress: { type: "assistant-message", sessionId: this.sessionId, turn: this.targetTurn, step: event.data.step, text: this.text } };
    }
    if (event.type === "tool/call" && event.data.turn === this.targetTurn) {
      const callId = String(event.data.callId);
      this.tools.set(callId, event.data.name);
      return { progress: { type: "tool-start", sessionId: this.sessionId, turn: this.targetTurn, step: event.data.step, callId, name: event.data.name } };
    }
    if (event.type === "tool/result" && event.data.turn === this.targetTurn) {
      const block = event.data.message.content[0];
      const callId = block?.type === "tool-result" ? String(block.toolCallId) : "tool-" + String(this.targetTurn) + "-" + String(event.data.step);
      const name = this.tools.get(callId) ?? "tool";
      return { progress: { type: "tool-end", sessionId: this.sessionId, turn: this.targetTurn, step: event.data.step, callId, name, failed: event.data.error !== undefined || block?.isError === true } };
    }
    if (event.type !== "turn/end" || event.data.turn !== this.targetTurn) return {};
    const result = { text: this.text || errorText(event.data.reason), reason: event.data.reason.kind, turn: event.data.turn } satisfies TurnResult;
    return { result, progress: { type: "turn-end", sessionId: this.sessionId, result } };
  }
}

function visibleText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

function errorText(reason: TurnEndReason): string {
  return reason.kind === "error" ? "DSH turn failed." : "";
}

/** Collects progress from a session subscription that may start mid-turn. */
export class ObservedTurnCollector {
  private turn?: number;
  private ended = false;
  private text = "";
  private readonly tools = new Map<string, string>();

  constructor(private readonly sessionId: string) {}

  accept(event: SessionEvent): readonly TurnProgress[] {
    const progress: TurnProgress[] = [];
    const eventTurn = eventTurnOf(event);
    if (event.type === "turn/start") {
      if (this.turn === undefined || event.data.turn > this.turn) this.begin(event.data.turn, progress);
      else return progress;
    } else if (eventTurn !== undefined) {
      if (this.turn !== undefined && eventTurn < this.turn) return progress;
      if (this.turn === undefined || eventTurn > this.turn) this.begin(eventTurn, progress);
      else if (this.ended) return progress;
    }
    if (this.turn === undefined) return progress;

    switch (event.type) {
      case "assistant/chunk":
        if (event.data.turn === this.turn && event.data.chunk.type === "text-delta" && event.data.chunk.text !== "") {
          this.text += event.data.chunk.text;
          progress.push({ type: "assistant-delta", sessionId: this.sessionId, turn: this.turn, step: event.data.step, text: event.data.chunk.text });
        }
        break;
      case "assistant/message":
        if (event.data.turn === this.turn) {
          this.text = visibleText(event.data.message.content);
          progress.push({ type: "assistant-message", sessionId: this.sessionId, turn: this.turn, step: event.data.step, text: this.text });
        }
        break;
      case "tool/call": {
        if (event.data.turn !== this.turn) break;
        const callId = String(event.data.callId);
        this.tools.set(callId, event.data.name);
        progress.push({ type: "tool-start", sessionId: this.sessionId, turn: this.turn, step: event.data.step, callId, name: event.data.name });
        break;
      }
      case "tool/result": {
        if (event.data.turn !== this.turn) break;
        const block = event.data.message.content[0];
        const callId = block?.type === "tool-result" ? String(block.toolCallId) : "tool-" + String(this.turn) + "-" + String(event.data.step);
        const name = this.tools.get(callId) ?? "tool";
        progress.push({ type: "tool-end", sessionId: this.sessionId, turn: this.turn, step: event.data.step, callId, name, failed: event.data.error !== undefined || block?.isError === true });
        this.tools.delete(callId);
        break;
      }
      case "turn/end": {
        if (event.data.turn !== this.turn) break;
        const result = { text: this.text || errorText(event.data.reason), reason: event.data.reason.kind, turn: event.data.turn } satisfies TurnResult;
        progress.push({ type: "turn-end", sessionId: this.sessionId, result });
        this.ended = true;
        break;
      }
    }
    return progress;
  }

  collect(event: SessionEvent): readonly TurnProgress[] {
    return this.accept(event);
  }

  private begin(turn: number, progress: TurnProgress[]): void {
    this.turn = turn;
    this.ended = false;
    this.text = "";
    this.tools.clear();
    progress.push({ type: "turn-start", sessionId: this.sessionId, turn });
  }
}

function eventTurnOf(event: SessionEvent): number | undefined {
  if (typeof event.data !== "object" || event.data === null) return undefined;
  const turn = (event.data as { readonly turn?: unknown }).turn;
  return typeof turn === "number" ? turn : undefined;
}

export class DshAdapter implements DshPort {
  private readonly handles = new Map<string, AgentHandle>();
  private readonly watchers = new Set<() => void>();

  constructor(private readonly ctx: Context, private readonly options: DshAdapterOptions) {
    if (!Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs < 1) throw new Error("turnTimeoutMs must be a positive integer");
  }

  async listAgentPresets(): Promise<readonly AgentPresetSummary[]> {
    const presets = await this.ctx.agentPresets.list();
    const defaultId = this.ctx.agentPresets.defaultId;
    return presets
      .filter((preset) => preset.broken === undefined)
      .map((preset) => ({
        id: preset.id,
        title: preset.name ?? preset.id,
        description: preset.description,
        isDefault: preset.id === defaultId
      }));
  }

  async listComputers(): Promise<readonly ComputerSummary[]> {
    return [{ id: "local", title: this.options.hostName, status: "online" }];
  }

  async listProjects(computerId: string): Promise<readonly ProjectSummary[]> {
    this.assertLocal(computerId);
    return Promise.all(this.ctx.workspaceRegistry.list().map(async (workspace) => ({
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
      status: (await workspace.status()) === "ok" ? "online" as const : "missing" as const
    })));
  }

  async listSessions(computerId: string, projectId: string): Promise<readonly SessionSummary[]> {
    this.assertLocal(computerId);
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(projectId));
    if (workspace === undefined) throw new Error("Unknown workspace");
    const archivedSessionIds = new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(String));
    const sessionIds = workspace.sessionIds.filter((sessionId) => !archivedSessionIds.has(String(sessionId)));
    return Promise.all(sessionIds.map(async (sessionId) => {
      const title = await this.ctx.sessionQuery.readTitle(sessionId);
      return { id: String(sessionId), title: title?.title ?? String(sessionId), status: this.liveStatus(String(sessionId)) };
    }));
  }

  async createSession(computerId: string, projectId: string, agentPresetId: string): Promise<SessionSummary> {
    if (typeof agentPresetId !== "string" || agentPresetId.length === 0) throw new Error("agentPresetId is required");
    this.assertLocal(computerId);
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(projectId));
    if (workspace === undefined) throw new Error("Unknown workspace");
    if ((await workspace.status()) !== "ok") throw new Error("Workspace directory is missing");
    const preset = (await this.ctx.agentPresets.list()).find((item) => item.id === agentPresetId && item.broken === undefined);
    if (preset === undefined) throw new Error("Agent preset is no longer available");
    const selection = this.ctx.agentDefaultModel.currentSelection();
    const presetId = preset.id;
    const sessionId = SessionId("session-" + randomUUID());
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

  watchSession(sessionId: string, listener: TurnProgressListener): () => void {
    const collector = new ObservedTurnCollector(sessionId);
    const unsubscribe = this.ctx.on("session/event", (session, event) => {
      if (String(session.id) !== sessionId) return;
      for (const progress of collector.accept(event)) listener(progress);
    });
    let active = true;
    const dispose = (): void => {
      if (!active) return;
      active = false;
      this.watchers.delete(dispose);
      unsubscribe();
    };
    this.watchers.add(dispose);
    return dispose;
  }

  async send(sessionId: string, text: string, onProgress?: TurnProgressListener): Promise<TurnResult> {
    const agent = await this.ensureAgent(sessionId);
    const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    const collector = new CorrelatedTurnCollector(String(message.id), sessionId);
    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      const dispose = this.ctx.on("session/event", (session, event) => {
        if (String(session.id) !== sessionId || settled) return;
        const update = collector.accept(event);
        if (update.progress !== undefined) onProgress?.(update.progress);
        if (update.result === undefined) return;
        settled = true;
        clearTimeout(timer);
        dispose();
        resolve(update.result);
      });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        dispose();
        reject(new Error("Timed out waiting for session " + sessionId));
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

  async status(sessionId: string): Promise<SessionSummary["status"]> { return this.liveStatus(sessionId); }

  async stop(sessionId: string): Promise<boolean> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined || agent.status !== "running") return false;
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return true;
  }

  async dispose(): Promise<void> {
    const watchers = [...this.watchers];
    for (const dispose of watchers) dispose();
    const handles = [...this.handles.values()].reverse();
    this.handles.clear();
    await Promise.allSettled(handles.map((handle) => handle.dispose()));
  }

  private assertLocal(computerId: string): void {
    if (computerId !== "local") throw new Error("Unknown computer");
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

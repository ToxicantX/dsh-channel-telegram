import type { TurnProgress } from "./ports.js";

interface ToolState {
  readonly name: string;
  status: "running" | "completed" | "failed";
}

export class ProgressRenderer {
  private sessionId = "";
  private status = "Queued";
  private turn?: number;
  private step?: number;
  private answer = "";
  private readonly tools = new Map<string, ToolState>();
  private final = false;

  accept(progress: TurnProgress): void {
    this.sessionId = progress.sessionId;
    switch (progress.type) {
      case "queued": this.status = "Queued"; break;
      case "turn-start": this.turn = progress.turn; this.status = "Running"; break;
      case "assistant-delta":
        if (this.step !== progress.step) { this.step = progress.step; this.answer = ""; }
        this.answer += progress.text;
        this.status = "Responding";
        break;
      case "assistant-message": this.step = progress.step; this.answer = progress.text; this.status = "Working"; break;
      case "tool-start":
        this.tools.set(progress.callId, { name: progress.name, status: "running" });
        this.status = "Using tools";
        this.trimTools();
        break;
      case "tool-end": {
        const tool = this.tools.get(progress.callId) ?? { name: progress.name, status: "running" as const };
        tool.status = progress.failed ? "failed" : "completed";
        this.tools.set(progress.callId, tool);
        this.status = progress.failed ? "Tool failed" : "Working";
        this.trimTools();
        break;
      }
      case "turn-end":
        this.turn = progress.result.turn;
        this.answer = progress.result.text || ("Turn ended: " + progress.result.reason + ".");
        this.status = progress.result.reason === "completed" ? "Completed" : "Ended: " + progress.result.reason;
        this.final = true;
        break;
      case "failed":
        this.answer = progress.message;
        this.status = "Failed";
        this.final = true;
        break;
    }
  }

  get isFinal(): boolean { return this.final; }

  renderFinalParts(): readonly string[] {
    if (!this.final) return [this.render()];
    const header = [this.status, "Session: " + compactId(this.sessionId), this.turn === undefined ? "" : "Turn: " + String(this.turn)].filter(Boolean).join("\n");
    const capacity = 4096 - header.length - 2;
    const answer = this.answer || this.status;
    const parts: string[] = [header + "\n\n" + answer.slice(0, capacity)];
    for (let index = capacity; index < answer.length; index += 4096) parts.push(answer.slice(index, index + 4096));
    return parts;
  }

  render(): string {
    const lines = [this.status, "Session: " + compactId(this.sessionId)];
    if (this.turn !== undefined) lines.push("Turn: " + String(this.turn));
    if (this.tools.size > 0 && !this.final) {
      lines.push("", "Tools");
      for (const tool of this.tools.values()) lines.push("- " + compact(tool.name, 48) + " (" + tool.status + ")");
    }
    if (this.answer !== "") lines.push("", compactTail(this.answer, 3200));
    return compactTail(lines.join("\n"), 4096);
  }

  private trimTools(): void {
    while (this.tools.size > 8) {
      const oldest = this.tools.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tools.delete(oldest);
    }
  }
}

export class ProgressMessageUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProgressMessageUnavailableError";
  }
}

export interface ProgressMessageTransport {
  send(text: string): Promise<{ readonly messageId: number }>;
  edit(messageId: number, text: string): Promise<void>;
}

export interface ProgressMessageEditorOptions {
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ProgressMessageEditor {
  private readonly renderer = new ProgressRenderer();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ProgressMessageEditorOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ProgressMessageEditorOptions["clearTimer"]>;
  private messageId?: number;
  private lastEditAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private editTail = Promise.resolve();
  private finalDelivered = false;
  private disposed = false;

  constructor(private readonly transport: ProgressMessageTransport, options: ProgressMessageEditorOptions = {}) {
    this.intervalMs = Math.max(250, options.intervalMs ?? 1000);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  async update(progress: TurnProgress): Promise<void> {
    if (this.disposed) return;
    this.renderer.accept(progress);
    if (this.messageId === undefined) {
      const [first = "", ...rest] = this.renderer.isFinal ? this.renderer.renderFinalParts() : [this.renderer.render()];
      const sent = await this.transport.send(first);
      this.messageId = sent.messageId;
      this.lastEditAt = this.now();
      if (this.renderer.isFinal) {
        this.finalDelivered = true;
        for (const part of rest) await this.transport.send(part);
      }
      return;
    }
    if (this.renderer.isFinal) {
      if (this.finalDelivered) return;
      if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
      const [first = "", ...rest] = this.renderer.renderFinalParts();
      await this.enqueueText(first);
      if (this.disposed) return;
      for (const part of rest) await this.transport.send(part);
      this.finalDelivered = true;
      return;
    }
    const delay = this.intervalMs - (this.now() - this.lastEditAt);
    if (delay <= 0) {
      await this.enqueueEdit();
      return;
    }
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        if (!this.disposed) void this.enqueueEdit();
      }, delay);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) { this.clearTimer(this.timer); this.timer = undefined; }
  }

  private async enqueueEdit(): Promise<void> {
    await this.enqueueText(this.renderer.render());
  }

  private async enqueueText(text: string): Promise<void> {
    if (this.disposed) return;
    const messageId = this.messageId;
    if (messageId === undefined) return;
    this.editTail = this.editTail.then(async () => {
      if (this.disposed) return;
      try {
        await this.transport.edit(messageId, text);
      } catch (error) {
        if (!(error instanceof ProgressMessageUnavailableError)) throw error;
        const replacement = await this.transport.send(text);
        this.messageId = replacement.messageId;
      }
    });
    await this.editTail;
    this.lastEditAt = this.now();
  }
}

function compact(value: string, length: number): string {
  return value.length <= length ? value : value.slice(0, Math.max(1, length - 3)) + "...";
}

function compactTail(value: string, length: number): string {
  return value.length <= length ? value : "..." + value.slice(-(length - 3));
}

function compactId(value: string): string {
  return value.length <= 20 ? value : "..." + value.slice(-16);
}

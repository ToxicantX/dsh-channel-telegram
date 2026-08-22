import type { TurnProgress } from "@wsxcant/dsh-channel-telegram-gateway";
import type { QQOpenApiClient, QQReplyContext } from "./api.js";
import { QQApiError } from "./types.js";

export interface QQProgressReporterOptions {
  readonly api: QQOpenApiClient;
  readonly userOpenId: string;
  readonly msgId?: string;
  readonly intervalMs?: number;
  readonly maxChars?: number;
  readonly now?: () => number;
  readonly shouldStop?: () => boolean;
}

export class QQProgressReporter {
  private readonly intervalMs: number;
  private readonly maxChars: number;
  private readonly now: () => number;
  private seq = 0;
  private lastStageAt = 0;
  private tail = Promise.resolve();
  private final = false;
  private inputSent = false;

  constructor(private readonly options: QQProgressReporterOptions) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 3_000);
    this.maxChars = Math.max(200, options.maxChars ?? 1_800);
    this.now = options.now ?? Date.now;
  }

  update(progress: TurnProgress): Promise<void> {
    this.tail = this.tail.then(() => this.apply(progress));
    return this.tail;
  }

  private async apply(progress: TurnProgress): Promise<void> {
    if (this.final || this.options.shouldStop?.()) { this.final = true; return; }
    if (!this.inputSent && this.options.msgId !== undefined && (progress.type === "queued" || progress.type === "turn-start")) {
      this.inputSent = true;
      this.seq += 1;
      await this.options.api.sendC2CInputNotify(this.options.userOpenId, this.options.msgId, this.seq).catch(() => undefined);
    }
    if (this.options.shouldStop?.()) { this.final = true; return; }
    if (progress.type === "turn-end") { this.final = true; await this.sendFinal(progress.result.text || ("Turn ended: " + progress.result.reason + ".")); return; }
    if (progress.type === "failed") { this.final = true; await this.sendFinal(progress.message); return; }
    const stage = renderStage(progress);
    if (stage === undefined || this.now() - this.lastStageAt < this.intervalMs) return;
    this.lastStageAt = this.now();
    await this.sendText(stage);
  }

  private async sendFinal(text: string): Promise<void> { if (this.options.shouldStop?.()) return; for (const part of splitText(text, this.maxChars)) await this.sendText(part); }
  private async sendText(content: string): Promise<void> {
    if (this.options.shouldStop?.()) { this.final = true; return; }
    this.seq += 1;
    const context: QQReplyContext = this.options.msgId === undefined ? {} : { msgId: this.options.msgId, msgSeq: this.seq };
    try { await this.options.api.sendC2CText(this.options.userOpenId, content, context); }
    catch (error) { if (this.options.msgId === undefined || !isExpiredReply(error)) throw error; await this.options.api.sendC2CText(this.options.userOpenId, content); }
  }
}

function renderStage(progress: TurnProgress): string | undefined {
  // QQ cannot edit a prior message, so tool names and repeated working notices only add noise.
  return progress.type === "turn-start" ? "Running turn " + String(progress.turn) + "..." : undefined;
}
function splitText(text: string, maxChars: number): readonly string[] { const chars = Array.from(text || "Completed."); const result: string[] = []; for (let i = 0; i < chars.length; i += maxChars) result.push(chars.slice(i, i + maxChars).join("")); return result; }
function isExpiredReply(error: unknown): boolean { return error instanceof QQApiError && (String(error.code) === "40034005" || String(error.code) === "40034024"); }

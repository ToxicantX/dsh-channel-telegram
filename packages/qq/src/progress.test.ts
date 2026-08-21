import type { TurnProgress } from "@wsxcant/dsh-channel-telegram-gateway";
import { describe, expect, it } from "vitest";
import type { QQOpenApiClient, QQReplyContext } from "./api.js";
import { QQProgressReporter } from "./progress.js";
import { QQApiError } from "./types.js";

class FakeApi {
  readonly values: { kind: string; content?: string; context?: QQReplyContext }[] = [];
  failExpired = false;
  async sendC2CInputNotify(_user: string, _msg: string, seq: number) { this.values.push({ kind: "input:" + seq }); }
  async sendC2CText(_user: string, content: string, context?: QQReplyContext) {
    if (this.failExpired && context?.msgId !== undefined) throw new QQApiError("expired", 400, 40034005);
    this.values.push({ kind: "text", content, context });
  }
}

describe("QQProgressReporter", () => {
  it("uses input status, throttles safe stages, and finalizes with increasing msg_seq", async () => {
    let now = 10_000; const api = new FakeApi(); const reporter = new QQProgressReporter({ api: api as unknown as QQOpenApiClient, userOpenId: "openid", msgId: "m1", intervalMs: 3_000, now: () => now });
    await reporter.update({ type: "queued", sessionId: "s" });
    await reporter.update({ type: "turn-start", sessionId: "s", turn: 1 });
    await reporter.update({ type: "tool-start", sessionId: "s", turn: 1, step: 1, callId: "c", name: "read" });
    now += 3_001; await reporter.update({ type: "tool-end", sessionId: "s", turn: 1, step: 1, callId: "c", name: "read", failed: false });
    await reporter.update({ type: "turn-end", sessionId: "s", result: { text: "answer", reason: "completed", turn: 1 } });
    expect(api.values).toEqual([
      { kind: "input:1" },
      { kind: "text", content: "Running turn 1...", context: { msgId: "m1", msgSeq: 2 } },
      { kind: "text", content: "Tool completed: read", context: { msgId: "m1", msgSeq: 3 } },
      { kind: "text", content: "answer", context: { msgId: "m1", msgSeq: 4 } }
    ]);
  });
  it("splits long Unicode final output without forwarding private progress types", async () => {
    const api = new FakeApi(); const reporter = new QQProgressReporter({ api: api as unknown as QQOpenApiClient, userOpenId: "openid", msgId: "m1", maxChars: 200, now: () => 10_000 });
    const ignored: TurnProgress = { type: "assistant-delta", sessionId: "s", turn: 1, step: 1, text: "private incremental text" }; await reporter.update(ignored);
    await reporter.update({ type: "turn-end", sessionId: "s", result: { text: "好".repeat(450), reason: "completed", turn: 1 } });
    expect(api.values).toHaveLength(3); expect(api.values.every((item) => (item.content?.length ?? 0) <= 200)).toBe(true);
  });
  it("falls back to a proactive send when the passive reply window expired", async () => {
    const api = new FakeApi(); api.failExpired = true;
    const reporter = new QQProgressReporter({ api: api as unknown as QQOpenApiClient, userOpenId: "openid", msgId: "m1", now: () => 10_000 });
    await reporter.update({ type: "turn-end", sessionId: "s", result: { text: "late", reason: "completed", turn: 1 } });
    expect(api.values).toEqual([{ kind: "text", content: "late", context: undefined }]);
  });
  it("stops sending after shouldStop becomes true", async () => {
    const api = new FakeApi(); let stopped = false;
    const reporter = new QQProgressReporter({ api: api as unknown as QQOpenApiClient, userOpenId: "openid", msgId: "m1", now: () => 10_000, shouldStop: () => stopped });
    stopped = true;
    await reporter.update({ type: "turn-end", sessionId: "s", result: { text: "late", reason: "completed", turn: 1 } });
    expect(api.values).toEqual([]);
  });
});

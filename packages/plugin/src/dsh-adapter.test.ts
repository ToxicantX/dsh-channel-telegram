import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { CorrelatedTurnCollector } from "./dsh-adapter.js";

function event(value: unknown): SessionEvent { return value as SessionEvent; }
function envelope(type: string, data: unknown, seq = 1) { return event({ type, seq, time: 1, data }); }

describe("CorrelatedTurnCollector", () => {
  it("emits progress only after matching the exact user message and turn", () => {
    const collector = new CorrelatedTurnCollector("wanted", "session-target");
    expect(collector.accept(envelope("turn/start", { turn: 4 }))).toEqual({});
    expect(collector.accept(envelope("user/message", { id: "other" }))).toEqual({});
    expect(collector.accept(envelope("assistant/chunk", { turn: 4, step: 1, chunk: { type: "text-delta", index: 0, text: "wrong" } }))).toEqual({});

    collector.accept(envelope("turn/start", { turn: 5 }));
    expect(collector.accept(envelope("user/message", { id: "wanted" })).progress).toEqual({ type: "turn-start", sessionId: "session-target", turn: 5 });
    expect(collector.accept(envelope("assistant/chunk", { turn: 9, step: 1, chunk: { type: "text-delta", index: 0, text: "other turn" } }))).toEqual({});
    expect(collector.accept(envelope("assistant/chunk", { turn: 5, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "private reasoning" } }))).toEqual({});
    expect(collector.accept(envelope("assistant/chunk", { turn: 5, step: 1, chunk: { type: "text-delta", index: 0, text: "partial" } })).progress).toEqual({
      type: "assistant-delta", sessionId: "session-target", turn: 5, step: 1, text: "partial"
    });

    expect(collector.accept(envelope("tool/call", { turn: 5, step: 1, callId: "call-1", name: "read", arguments: "{sensitive}" })).progress).toEqual({
      type: "tool-start", sessionId: "session-target", turn: 5, step: 1, callId: "call-1", name: "read"
    });
    expect(collector.accept(envelope("tool/result", { turn: 5, step: 1, message: { content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "sensitive result" }] }] } })).progress).toEqual({
      type: "tool-end", sessionId: "session-target", turn: 5, step: 1, callId: "call-1", name: "read", failed: false
    });

    expect(collector.accept(envelope("assistant/message", { turn: 5, step: 2, message: { content: [{ type: "text", text: "answer" }] } })).progress).toEqual({
      type: "assistant-message", sessionId: "session-target", turn: 5, step: 2, text: "answer"
    });
    const completed = collector.accept(envelope("turn/end", { turn: 5, reason: { kind: "completed" } }));
    expect(completed.result).toEqual({ text: "answer", reason: "completed", turn: 5 });
    expect(completed.progress).toEqual({ type: "turn-end", sessionId: "session-target", result: completed.result });
  });

  it("surfaces structured DSH errors when no assistant text exists", () => {
    const collector = new CorrelatedTurnCollector("wanted", "session-target");
    collector.accept(envelope("turn/start", { turn: 2 }));
    collector.accept(envelope("user/message", { id: "wanted" }));
    expect(collector.accept(envelope("turn/end", { turn: 2, reason: { kind: "error", error: { message: "failed", code: "UNKNOWN" } } })).result)
      .toEqual({ text: "DSH error: failed", reason: "error", turn: 2 });
  });
});

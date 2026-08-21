import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { CorrelatedTurnCollector } from "./dsh-adapter.js";

const event = (value: unknown) => value as SessionEvent;

describe("CorrelatedTurnCollector", () => {
  it("ignores another turn and resolves the turn containing its message id", () => {
    const collector = new CorrelatedTurnCollector("wanted");
    collector.accept(event({ type: "turn/start", seq: 1, time: 1, data: { turn: 4 } }));
    collector.accept(event({ type: "user/message", seq: 2, time: 1, data: { id: "other" } }));
    collector.accept(event({ type: "turn/end", seq: 3, time: 1, data: { turn: 4, reason: { kind: "completed" } } }));
    collector.accept(event({ type: "turn/start", seq: 4, time: 1, data: { turn: 5 } }));
    collector.accept(event({ type: "user/message", seq: 5, time: 1, data: { id: "wanted" } }));
    collector.accept(event({ type: "assistant/message", seq: 6, time: 1, data: { turn: 5, step: 1, message: { content: [{ type: "text", text: "answer" }] } } }));
    expect(collector.accept(event({ type: "turn/end", seq: 7, time: 1, data: { turn: 5, reason: { kind: "completed" } } })))
      .toEqual({ text: "answer", reason: "completed", turn: 5 });
  });

  it("surfaces structured DSH errors when no assistant text exists", () => {
    const collector = new CorrelatedTurnCollector("wanted");
    collector.accept(event({ type: "turn/start", seq: 1, time: 1, data: { turn: 2 } }));
    collector.accept(event({ type: "user/message", seq: 2, time: 1, data: { id: "wanted" } }));
    expect(collector.accept(event({ type: "turn/end", seq: 3, time: 1, data: { turn: 2, reason: { kind: "error", error: { message: "failed", code: "UNKNOWN" } } } })))
      .toEqual({ text: "DSH error: failed", reason: "error", turn: 2 });
  });
});

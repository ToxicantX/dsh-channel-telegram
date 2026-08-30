import { describe, expect, it } from "vitest";
import { ProgressMessageEditor, ProgressMessageUnavailableError, ProgressRenderer } from "./progress.js";

const result = (text: string) => ({ text, reason: "completed", turn: 7 } as const);

describe("ProgressRenderer", () => {
  it("renders tool names without arguments or result content and finalizes the answer", () => {
    const renderer = new ProgressRenderer();
    renderer.accept({ type: "turn-start", sessionId: "session-one", turn: 7 });
    renderer.accept({ type: "tool-start", sessionId: "session-one", turn: 7, step: 1, callId: "c1", name: "read" });
    renderer.accept({ type: "tool-end", sessionId: "session-one", turn: 7, step: 1, callId: "c1", name: "read", failed: false });
    expect(renderer.render()).toContain("read (completed)");
    renderer.accept({ type: "turn-end", sessionId: "session-one", result: result("final answer") });
    expect(renderer.renderFinalParts()).toEqual([expect.stringContaining("final answer")]);
    expect(renderer.renderFinalParts()[0]).not.toContain("Tools");
  });

  it("splits long final answers without losing text", () => {
    const renderer = new ProgressRenderer();
    const text = "x".repeat(9000);
    renderer.accept({ type: "turn-end", sessionId: "session-one", result: result(text) });
    const parts = renderer.renderFinalParts();
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.join("").match(/x/g)?.length).toBe(text.length);
  });
});

describe("ProgressMessageEditor", () => {
  it("coalesces intermediate updates and flushes final output immediately", async () => {
    const sent: string[] = [];
    const edits: string[] = [];
    let now = 0;
    let scheduled: (() => void) | undefined;
    const editor = new ProgressMessageEditor({
      send: async (text) => { sent.push(text); return { messageId: 1 }; },
      edit: async (_id, text) => { edits.push(text); }
    }, {
      intervalMs: 1000,
      now: () => now,
      setTimer: (callback) => { scheduled = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => { scheduled = undefined; }
    });
    await editor.update({ type: "queued", sessionId: "session-one", waiting: false });
    await editor.update({ type: "turn-start", sessionId: "session-one", turn: 7 });
    await editor.update({ type: "assistant-delta", sessionId: "session-one", turn: 7, step: 1, text: "partial" });
    expect(sent).toHaveLength(1);
    expect(edits).toHaveLength(0);
    now = 1000;
    scheduled?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(edits.at(-1)).toContain("partial");
    await editor.update({ type: "turn-end", sessionId: "session-one", result: result("final") });
    expect(edits.at(-1)).toContain("final");
  });

  it("sends a replacement when the original progress message is unavailable", async () => {
    const sent: string[] = [];
    const editor = new ProgressMessageEditor({
      send: async (text) => { sent.push(text); return { messageId: sent.length }; },
      edit: async () => { throw new ProgressMessageUnavailableError("deleted"); }
    });
    await editor.update({ type: "queued", sessionId: "session-one", waiting: false });
    await editor.update({ type: "turn-end", sessionId: "session-one", result: result("replacement final") });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("replacement final");
  });

  it("does not hide non-recoverable Telegram edit errors", async () => {
    const editor = new ProgressMessageEditor({
      send: async () => ({ messageId: 1 }),
      edit: async () => { throw new Error("Too Many Requests: retry after 3"); }
    });
    await editor.update({ type: "queued", sessionId: "session-one", waiting: false });
    await expect(editor.update({ type: "turn-end", sessionId: "session-one", result: result("final") }))
      .rejects.toThrow("Too Many Requests");
  });

  it("cancels pending edits and ignores updates after disposal", async () => {
    const sent: string[] = [];
    const edits: string[] = [];
    let scheduled: (() => void) | undefined;
    const editor = new ProgressMessageEditor({
      send: async (text) => { sent.push(text); return { messageId: 1 }; },
      edit: async (_id, text) => { edits.push(text); }
    }, {
      intervalMs: 1000,
      now: () => 0,
      setTimer: (callback) => { scheduled = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => { scheduled = undefined; }
    });
    await editor.update({ type: "queued", sessionId: "session-one", waiting: false });
    await editor.update({ type: "turn-start", sessionId: "session-one", turn: 7 });
    expect(scheduled).toBeTypeOf("function");
    editor.dispose();
    expect(scheduled).toBeUndefined();
    await editor.update({ type: "turn-end", sessionId: "session-one", result: result("late") });
    expect(sent).toHaveLength(1);
    expect(edits).toHaveLength(0);
  });

  it("sends continuation messages for final output over 4096 characters", async () => {
    const sent: string[] = [];
    const edits: string[] = [];
    const editor = new ProgressMessageEditor({
      send: async (text) => { sent.push(text); return { messageId: sent.length }; },
      edit: async (_id, text) => { edits.push(text); }
    });
    await editor.update({ type: "queued", sessionId: "session-one", waiting: false });
    await editor.update({ type: "turn-end", sessionId: "session-one", result: result("x".repeat(9000)) });
    expect(edits).toHaveLength(1);
    expect(sent.length).toBeGreaterThan(2);
    expect(edits[0]!.length).toBeLessThanOrEqual(4096);
    expect(sent.slice(1).every((part) => part.length <= 4096)).toBe(true);
  });
});

import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { CorrelatedTurnCollector, DshAdapter, ObservedTurnCollector } from "./dsh-adapter.js";

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
      .toEqual({ text: "DSH turn failed.", reason: "error", turn: 2 });
  });
});

describe("DshAdapter.send", () => {
  it("subscribes before followup and ignores every other session and turn", async () => {
    type EventListener = (session: { id: string }, event: SessionEvent) => void;
    let listener: EventListener | undefined;
    let disposed = 0;
    const targetSession = { id: "session-target" };
    const otherSession = { id: "session-other" };
    const agent = {
      status: "idle",
      followup(message: { id: string }) {
        expect(listener).toBeTypeOf("function");
        listener?.(otherSession, envelope("turn/start", { turn: 90 }));
        listener?.(otherSession, envelope("user/message", { id: message.id }));
        listener?.(otherSession, envelope("assistant/message", { turn: 90, step: 1, message: { content: [{ type: "text", text: "other session" }] } }));
        listener?.(targetSession, envelope("turn/start", { turn: 3 }));
        listener?.(targetSession, envelope("user/message", { id: "gui-message" }));
        listener?.(targetSession, envelope("assistant/message", { turn: 3, step: 1, message: { content: [{ type: "text", text: "other turn" }] } }));
        listener?.(targetSession, envelope("turn/end", { turn: 3, reason: { kind: "completed" } }));
        listener?.(targetSession, envelope("turn/start", { turn: 4 }));
        listener?.(targetSession, envelope("user/message", { id: message.id }));
        listener?.(targetSession, envelope("assistant/chunk", { turn: 4, step: 1, chunk: { type: "text-delta", index: 0, text: "target" } }));
        listener?.(targetSession, envelope("assistant/message", { turn: 4, step: 1, message: { content: [{ type: "text", text: "target answer" }] } }));
        listener?.(targetSession, envelope("turn/end", { turn: 4, reason: { kind: "completed" } }));
      }
    };
    const ctx = {
      agents: { get: (sessionId: string) => String(sessionId) === targetSession.id ? agent : undefined },
      on: (_event: string, value: EventListener) => {
        listener = value;
        return () => { disposed += 1; listener = undefined; };
      }
    } as unknown as Context;
    const adapter = new DshAdapter(ctx, { turnTimeoutMs: 1000, hostName: "Build Host" });
    await expect(adapter.listComputers()).resolves.toEqual([{ id: "local", title: "Build Host", status: "online" }]);
    const progress: string[] = [];
    const result = await adapter.send(targetSession.id, "hello", (event) => { progress.push(event.type); });
    expect(result).toEqual({ text: "target answer", reason: "completed", turn: 4 });
    expect(progress).toEqual(["turn-start", "assistant-delta", "assistant-message", "turn-end"]);
    expect(disposed).toBe(1);
    expect(listener).toBeUndefined();
  });
});

describe("ObservedTurnCollector", () => {
  it("maps visible output and tool status without leaking private fields", () => {
    const collector = new ObservedTurnCollector("session-observed");
    expect(collector.accept(envelope("turn/start", { turn: 7 }))).toEqual([
      { type: "turn-start", sessionId: "session-observed", turn: 7 }
    ]);
    expect(collector.accept(envelope("assistant/chunk", {
      turn: 7, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "private" }
    }))).toEqual([]);
    expect(collector.accept(envelope("assistant/chunk", {
      turn: 7, step: 1, chunk: { type: "text-delta", index: 0, text: "visible " }
    }))).toEqual([
      { type: "assistant-delta", sessionId: "session-observed", turn: 7, step: 1, text: "visible " }
    ]);
    expect(collector.accept(envelope("tool/call", {
      turn: 7, step: 1, callId: "call-7", name: "read", arguments: "{secret}"
    }))).toEqual([
      { type: "tool-start", sessionId: "session-observed", turn: 7, step: 1, callId: "call-7", name: "read" }
    ]);
    expect(collector.accept(envelope("tool/result", {
      turn: 7, step: 1, message: { content: [{
        type: "tool-result", toolCallId: "call-7", isError: true, content: [{ type: "text", text: "secret result" }]
      }] }, error: { name: "ToolError", code: "E_TOOL" }, result: "secret body"
    }))).toEqual([
      { type: "tool-end", sessionId: "session-observed", turn: 7, step: 1, callId: "call-7", name: "read", failed: true }
    ]);
    expect(collector.accept(envelope("assistant/message", {
      turn: 7, step: 2, message: { content: [{ type: "reasoning", text: "private" }, { type: "text", text: "answer" }] }
    }))).toEqual([
      { type: "assistant-message", sessionId: "session-observed", turn: 7, step: 2, text: "answer" }
    ]);
    expect(collector.accept(envelope("turn/end", { turn: 7, reason: { kind: "completed" } }))).toEqual([
      { type: "turn-end", sessionId: "session-observed", result: { text: "answer", reason: "completed", turn: 7 } }
    ]);
    expect(collector.accept(envelope("assistant/message", {
      turn: 7, step: 3, message: { content: [{ type: "text", text: "late" }] }
    }))).toEqual([]);
    expect(collector.accept(envelope("assistant/chunk", {
      turn: 6, step: 1, chunk: { type: "text-delta", index: 0, text: "older" }
    }))).toEqual([]);
  });

  it("infers a mid-turn subscription and resets sequential turn state", () => {
    const collector = new ObservedTurnCollector("session-observed");
    expect(collector.accept(envelope("assistant/chunk", {
      turn: 3, step: 1, chunk: { type: "text-delta", index: 0, text: "mid" }
    }))).toEqual([
      { type: "turn-start", sessionId: "session-observed", turn: 3 },
      { type: "assistant-delta", sessionId: "session-observed", turn: 3, step: 1, text: "mid" }
    ]);
    expect(collector.accept(envelope("tool/call", {
      turn: 3, step: 1, callId: "same-call", name: "old-tool", arguments: "{}"
    }))).toHaveLength(1);
    expect(collector.accept(envelope("turn/start", { turn: 4 }))).toEqual([
      { type: "turn-start", sessionId: "session-observed", turn: 4 }
    ]);
    expect(collector.accept(envelope("tool/result", {
      turn: 4, step: 1, message: { content: [{ type: "tool-result", toolCallId: "same-call", content: [] }] }
    }))).toEqual([
      { type: "tool-end", sessionId: "session-observed", turn: 4, step: 1, callId: "same-call", name: "tool", failed: false }
    ]);
    expect(collector.accept(envelope("tool/result", {
      turn: 4, step: 2, message: { content: [] }
    }))).toEqual([
      { type: "tool-end", sessionId: "session-observed", turn: 4, step: 2, callId: "tool-4-2", name: "tool", failed: false }
    ]);
    expect(collector.accept(envelope("turn/end", { turn: 4, reason: { kind: "completed" } }))).toEqual([
      { type: "turn-end", sessionId: "session-observed", result: { text: "", reason: "completed", turn: 4 } }
    ]);
  });
});

describe("DshAdapter session listing", () => {
  it("keeps idle and running sessions but excludes globally archived sessions", async () => {
    const titleReads: string[] = [];
    const workspace = {
      id: "project-1",
      title: "Project",
      path: "C:\\workspace\\project-1",
      sessionIds: ["session-idle", "session-running", "session-archived"],
      status: async () => "ok" as const
    };
    const ctx = {
      workspaceRegistry: {
        get: () => workspace,
        archivedSessionIds: ["session-archived"]
      },
      sessionQuery: {
        readTitle: async (sessionId: string) => { titleReads.push(sessionId); return { title: "Title " + sessionId }; }
      },
      agents: {
        get: (sessionId: string) => sessionId === "session-running" ? { status: "running" } : sessionId === "session-idle" ? { status: "idle" } : undefined
      }
    } as unknown as Context;
    const adapter = new DshAdapter(ctx, { turnTimeoutMs: 1000, hostName: "Build Host" });

    await expect(adapter.listSessions("local", "project-1")).resolves.toEqual([
      { id: "session-idle", title: "Title session-idle", status: "idle" },
      { id: "session-running", title: "Title session-running", status: "running" }
    ]);
    expect(titleReads).toEqual(["session-idle", "session-running"]);
  });
});

describe("DshAdapter inbound attachments", () => {
  it("persists images and appends text file content to the user message", async () => {
    let followed: any; let listener: ((session: { id: string }, event: SessionEvent) => void) | undefined;
    const agent = { status: "idle", followup: (message: any) => { followed = message; listener?.({ id: "s1" }, envelope("turn/start", { turn: 1 })); listener?.({ id: "s1" }, envelope("user/message", { id: message.id })); listener?.({ id: "s1" }, envelope("turn/end", { turn: 1, reason: { kind: "completed" } })); } };
    const saved: any[] = [];
    const ctx = {
      attachments: { saveImage: async (input: any) => { saved.push(input); return { attachmentId: "att-1", mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 }; } },
      agents: { get: () => agent }, on: (_name: string, value: any) => { listener = value; return () => { listener = undefined; }; }
    } as unknown as Context;
    const adapter = new DshAdapter(ctx, { turnTimeoutMs: 1000, hostName: "Build Host" });
    await adapter.send("s1", "caption", undefined, [
      { type: "image", data: new Uint8Array([1, 2]), mediaType: "image/png", name: "x.png" },
      { type: "file", data: new TextEncoder().encode("hello"), mediaType: "text/plain", name: "note.txt" }
    ]);
    expect(saved).toHaveLength(1);
    expect(followed.content).toEqual([{ type: "text", text: "caption" }, { type: "image", attachment: saved[0] && expect.anything() }, { type: "text", text: "\n\n[Attached file: note.txt]\nhello" }]);
  });
});

describe("DshAdapter presets and watchSession", () => {
  it("filters broken presets and passes the selected preset through metadata and setup", async () => {
    let listCalls = 0;
    let mounted: string | undefined;
    let created: any;
    const workspace = {
      id: "project-1", title: "Project", path: "C:\\workspace\\project-1", sessionIds: [],
      status: async () => "ok" as const, attachSession: async () => undefined
    };
    const ctx = {
      agentPresets: {
        defaultId: "named",
        list: async () => {
          listCalls += 1;
          return [
            { id: "default", description: "Default" },
            { id: "named", name: "Named", description: "Named description" },
            { id: "broken-empty", name: "Broken", broken: "" },
            { id: "broken", name: "Broken", broken: "invalid yaml" }
          ];
        },
        mount: async (_agentCtx: Context, id?: string) => { mounted = id; }
      },
      workspaceRegistry: { get: () => workspace },
      agentDefaultModel: { currentSelection: () => ({ provider: "provider", model: "model" }) },
      agents: {
        create: async (options: any) => {
          created = options;
          await options.setup({ on: () => () => true } as unknown as Context);
          return { agent: { status: "idle" }, dispose: async () => undefined };
        },
        get: () => undefined
      },
      on: () => () => true
    } as unknown as Context;
    const adapter = new DshAdapter(ctx, { turnTimeoutMs: 1000, hostName: "Build Host" });

    await expect(adapter.listAgentPresets()).resolves.toEqual([
      { id: "default", title: "default", description: "Default", isDefault: false },
      { id: "named", title: "Named", description: "Named description", isDefault: true }
    ]);
    expect(listCalls).toBe(1);

    await adapter.createSession("local", "project-1", "named");
    expect(created.meta).toEqual({ cwd: workspace.path, agentPreset: "named" });
    expect(mounted).toBe("named");
    expect(listCalls).toBe(2);
    await expect(adapter.createSession("local", "project-1")).rejects.toThrow("agentPresetId is required");
  });

  it("isolates sessions, disposes watch subscriptions idempotently, and disposes before handles", async () => {
    type EventListener = (session: { id: string }, event: SessionEvent) => void;
    const subscriptions: { active: boolean; listener: EventListener }[] = [];
    const order: string[] = [];
    let unsubscribeCalls = 0;
    const workspace = {
      id: "project-1", title: "Project", path: "C:\\workspace\\project-1", sessionIds: [],
      status: async () => "ok" as const, attachSession: async () => undefined
    };
    const ctx = {
      agentPresets: { defaultId: "default", list: async () => [{ id: "default" }], mount: async () => undefined },
      workspaceRegistry: { get: () => workspace },
      agentDefaultModel: { currentSelection: () => ({ provider: "provider", model: "model" }) },
      agents: {
        create: async () => ({ agent: { status: "idle" }, dispose: async () => { order.push("handle"); } }),
        get: () => undefined
      },
      on: (_name: string, listener: EventListener) => {
        const subscription = { active: true, listener };
        subscriptions.push(subscription);
        return () => {
          if (!subscription.active) return false;
          subscription.active = false;
          unsubscribeCalls += 1;
          order.push("watcher");
          return true;
        };
      }
    } as unknown as Context;
    const emit = (sessionId: string, value: unknown): void => {
      for (const subscription of subscriptions) {
        if (subscription.active) subscription.listener({ id: sessionId }, event(value));
      }
    };
    const adapter = new DshAdapter(ctx, { turnTimeoutMs: 1000, hostName: "Build Host" });
    const seen: string[] = [];
    const stop = adapter.watchSession("session-target", (progress) => { seen.push(progress.type + ":" + progress.sessionId); });

    emit("session-other", { type: "assistant/chunk", seq: 1, time: 1, data: { turn: 8, step: 1, chunk: { type: "text-delta", index: 0, text: "other" } } });
    emit("session-target", { type: "assistant/chunk", seq: 2, time: 1, data: { turn: 8, step: 1, chunk: { type: "text-delta", index: 0, text: "target" } } });
    expect(seen).toEqual(["turn-start:session-target", "assistant-delta:session-target"]);

    stop();
    stop();
    emit("session-target", { type: "turn/end", seq: 3, time: 1, data: { turn: 8, reason: { kind: "completed" } } });
    expect(seen).toHaveLength(2);
    expect(unsubscribeCalls).toBe(1);

    const secondStop = adapter.watchSession("session-target", () => undefined);
    await adapter.createSession("local", "project-1", "default");
    await adapter.dispose();
    secondStop();
    expect(order).toEqual(["watcher", "watcher", "handle"]);
    expect(unsubscribeCalls).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { QQGatewayConnection, type QQSocketCloseEvent, type QQSocketMessageEvent, type QQWebSocketLike } from "./websocket.js";
import type { QQOpenApiClient } from "./api.js";
import type { QQAccessTokenManager } from "./token.js";

class FakeSocket implements QQWebSocketLike {
  readyState = 1; readonly sent: unknown[] = [];
  private readonly messages = new Set<(event: QQSocketMessageEvent) => void>();
  private readonly closes = new Set<(event: QQSocketCloseEvent) => void>();
  private readonly errors = new Set<() => void>();
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code = 1000): void { this.readyState = 3; this.emitClose(code); }
  addEventListener(type: "message" | "close" | "error", listener: any): void { this.set(type).add(listener); }
  removeEventListener(type: "message" | "close" | "error", listener: any): void { this.set(type).delete(listener); }
  emit(value: unknown): void { for (const listener of [...this.messages]) listener({ data: JSON.stringify(value) }); }
  emitClose(code: number): void { for (const listener of [...this.closes]) listener({ code }); }
  emitError(): void {
    if (this.errors.size === 0) throw new Error("unhandled websocket error");
    for (const listener of [...this.errors]) listener();
  }
  private set(type: "message" | "close" | "error"): Set<any> { return type === "message" ? this.messages : type === "close" ? this.closes : this.errors; }
}

class ConnectingSocket extends FakeSocket {
  readyState = 0;
  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setImmediate(() => { this.emitError(); this.readyState = 3; this.emitClose(code); });
  }
}

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => { setImmediate(resolve); }); }
function dependencies() {
  const sockets: FakeSocket[] = []; const intervals: (() => void)[] = []; const cleared: number[] = [];
  const api = { getGatewayUrl: async () => "wss://gateway" } as QQOpenApiClient;
  const tokenManager = { get: async () => "access" } as QQAccessTokenManager;
  const connection = new QQGatewayConnection({
    api, tokenManager,
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    setInterval: (callback) => { intervals.push(callback); return intervals.length as unknown as ReturnType<typeof setInterval>; },
    clearInterval: (timer) => { cleared.push(Number(timer)); },
    sleep: async () => undefined,
    reconnectDelaysMs: [0]
  });
  return { connection, sockets, intervals, cleared };
}

describe("QQGatewayConnection", () => {
  it("keeps the WebSocket error handled when aborted during connection", async () => {
    const socket = new ConnectingSocket();
    const abort = new AbortController();
    const connection = new QQGatewayConnection({
      api: { getGatewayUrl: async () => "wss://gateway" } as QQOpenApiClient,
      tokenManager: { get: async () => "access" } as QQAccessTokenManager,
      socketFactory: () => socket
    });
    const running = connection.run(abort.signal, () => undefined);
    await flush();
    abort.abort();
    await running;
    await flush();
  });

  it("retries transient discovery failures with the first backoff delay", async () => {
    let attempts = 0;
    const sockets: FakeSocket[] = [];
    const sleeps: number[] = [];
    const abort = new AbortController();
    const connection = new QQGatewayConnection({
      api: { getGatewayUrl: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary discovery failure"); return "wss://gateway"; } } as QQOpenApiClient,
      tokenManager: { get: async () => "access" } as QQAccessTokenManager,
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      sleep: async (ms) => { sleeps.push(ms); },
      reconnectDelaysMs: [5, 10]
    });
    const running = connection.run(abort.signal, () => undefined);
    await flush();
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([5]);
    expect(sockets).toHaveLength(1);
    abort.abort();
    await running;
  });

  it("identifies, advances seq after processing, heartbeats, and resumes", async () => {
    const { connection, sockets, intervals } = dependencies(); const abort = new AbortController(); let release = () => undefined;
    const handled: string[] = [];
    const running = connection.run(abort.signal, async (message) => { handled.push(message.dedupeKey); await new Promise<void>((resolve) => { release = resolve; }); });
    await flush(); const first = sockets[0]!;
    first.emit({ op: 10, d: { heartbeat_interval: 45000 } });
    expect(first.sent[0]).toEqual(expect.objectContaining({ op: 2, d: expect.objectContaining({ token: "QQBot access", intents: (1 << 25) | (1 << 26), shard: [0, 1] }) }));
    first.emit({ op: 0, s: 1, t: "READY", d: { session_id: "session-one" } }); await flush();
    first.emit({ op: 0, s: 2, t: "C2C_MESSAGE_CREATE", d: { id: "m1", author: { user_openid: "openid" }, content: "hello", message_scene: { ext: ["msg_idx=1"] } } });
    await Promise.resolve(); intervals[0]?.(); expect(first.sent.at(-1)).toEqual({ op: 1, d: 1 });
    first.emit({ op: 11 }); release(); await flush(); intervals[0]?.(); expect(first.sent.at(-1)).toEqual({ op: 1, d: 2 });
    first.close(4009); await flush(); const second = sockets[1]!; second.emit({ op: 10, d: { heartbeat_interval: 45000 } });
    expect(second.sent[0]).toEqual({ op: 6, d: { token: "QQBot access", session_id: "session-one", seq: 2 } });
    expect(handled).toEqual(["m1:1"]); abort.abort(); await running;
  });

  it("dispatches C2C button interactions and advances seq after processing", async () => {
    const { connection, sockets, intervals } = dependencies(); const abort = new AbortController();
    const interactions: string[] = [];
    const running = connection.run(abort.signal, () => undefined, async (interaction) => { interactions.push(interaction.data); });
    await flush(); const socket = sockets[0]!;
    socket.emit({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.emit({ op: 0, s: 1, t: "READY", d: { session_id: "session-one" } }); await flush();
    socket.emit({ op: 0, s: 2, t: "INTERACTION_CREATE", d: { id: "interaction-1", chat_type: 2, scene: "c2c", user_openid: "openid", data: { resolved: { button_data: "m:token", button_id: "button-1" } } } });
    await flush();
    intervals[0]?.();
    expect(interactions).toEqual(["m:token"]);
    expect(socket.sent.at(-1)).toEqual({ op: 1, d: 2 });
    abort.abort(); await running;
  });

  it("times out missing heartbeat ACK then resumes, and identifies after invalid session", async () => {
    const { connection, sockets, intervals } = dependencies(); const abort = new AbortController();
    const running = connection.run(abort.signal, () => undefined); await flush();
    sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 1 } });
    sockets[0]!.emit({ op: 0, s: 1, t: "READY", d: { session_id: "session-one" } }); await flush();
    intervals[0]?.(); expect(sockets[0]!.sent.at(-1)).toEqual({ op: 1, d: 1 });
    intervals[0]?.(); await flush();
    const second = sockets[1]!; second.emit({ op: 10, d: { heartbeat_interval: 1 } });
    expect(second.sent[0]).toEqual({ op: 6, d: { token: "QQBot access", session_id: "session-one", seq: 1 } });
    second.emit({ op: 9 }); await flush();
    const third = sockets[2]!; third.emit({ op: 10, d: { heartbeat_interval: 1 } });
    expect(third.sent[0]).toEqual(expect.objectContaining({ op: 2 }));
    abort.abort(); await running;
  });

  it("clears heartbeat immediately on abort even while a dispatch is in flight", async () => {
    const { connection, sockets, intervals, cleared } = dependencies(); const abort = new AbortController();
    let release = () => undefined;
    const running = connection.run(abort.signal, async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    await flush();
    sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 45000 } });
    sockets[0]!.emit({ op: 0, s: 1, t: "READY", d: { session_id: "s" } }); await flush();
    sockets[0]!.emit({ op: 0, s: 2, t: "C2C_MESSAGE_CREATE", d: { id: "m1", author: { user_openid: "openid" }, content: "hello" } });
    await Promise.resolve();
    expect(intervals).toHaveLength(1);
    abort.abort();
    await flush();
    expect(cleared).toContain(1);
    intervals[0]?.();
    expect(sockets[0]!.sent.some((value) => (value as { op?: number }).op === 1)).toBe(false);
    release();
    await running;
  });

  it("falls back to identify for invalid sessions and rejects terminal account states", async () => {
    const firstDeps = dependencies(); const abort = new AbortController(); const run = firstDeps.connection.run(abort.signal, () => undefined); await flush();
    firstDeps.sockets[0]!.emit({ op: 10, d: { heartbeat_interval: 1 } }); firstDeps.sockets[0]!.emit({ op: 0, s: 1, t: "READY", d: { session_id: "s" } }); await flush();
    firstDeps.sockets[0]!.close(4006); await flush(); firstDeps.sockets[1]!.emit({ op: 10, d: { heartbeat_interval: 1 } }); expect(firstDeps.sockets[1]!.sent[0]).toEqual(expect.objectContaining({ op: 2 })); abort.abort(); await run;

    const terminal = dependencies(); const terminalRun = terminal.connection.run(new AbortController().signal, () => undefined); await flush(); terminal.sockets[0]!.close(4914); await expect(terminalRun).rejects.toThrow(/not allowed/u);
    const banned = dependencies(); const bannedRun = banned.connection.run(new AbortController().signal, () => undefined); await flush(); banned.sockets[0]!.close(4915); await expect(bannedRun).rejects.toThrow(/not allowed/u);
  });
});

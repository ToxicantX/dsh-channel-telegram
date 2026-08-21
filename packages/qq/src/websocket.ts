import WebSocket from "ws";
import type { QQOpenApiClient } from "./api.js";
import type { QQAccessTokenManager } from "./token.js";
import { QQ_C2C_INTENT, QQApiError, type QQC2CMessage, type QQGatewayPayload } from "./types.js";
import { decodeC2CMessage, decodeGatewayPayload } from "./wire.js";

export interface QQSocketMessageEvent { readonly data: unknown; }
export interface QQSocketCloseEvent { readonly code: number; readonly reason?: string; }
export interface QQWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: QQSocketMessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: QQSocketCloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: QQSocketMessageEvent) => void): void;
  removeEventListener(type: "close", listener: (event: QQSocketCloseEvent) => void): void;
  removeEventListener(type: "error", listener: () => void): void;
}

export interface QQGatewayConnectionOptions {
  readonly api: QQOpenApiClient;
  readonly tokenManager: QQAccessTokenManager;
  readonly socketFactory?: (url: string) => QQWebSocketLike;
  readonly setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly reconnectDelaysMs?: readonly number[];
}

interface ResumeState { sessionId: string; seq?: number; }
interface CloseResult { code: number; ready: boolean; }

export class QQGatewayConnection {
  private readonly socketFactory: NonNullable<QQGatewayConnectionOptions["socketFactory"]>;
  private readonly setHeartbeat: NonNullable<QQGatewayConnectionOptions["setInterval"]>;
  private readonly clearHeartbeat: NonNullable<QQGatewayConnectionOptions["clearInterval"]>;
  private readonly sleep: NonNullable<QQGatewayConnectionOptions["sleep"]>;
  private readonly delays: readonly number[];
  private resume?: ResumeState;

  constructor(private readonly options: QQGatewayConnectionOptions) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url) as unknown as QQWebSocketLike);
    this.setHeartbeat = options.setInterval ?? setInterval;
    this.clearHeartbeat = options.clearInterval ?? clearInterval;
    this.sleep = options.sleep ?? abortableSleep;
    this.delays = options.reconnectDelaysMs ?? [500, 1_000, 2_000, 5_000, 10_000];
    if (this.delays.length === 0 || this.delays.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("reconnectDelaysMs must contain non-negative integers");
  }

  async run(signal: AbortSignal, onMessage: (message: QQC2CMessage, payload: QQGatewayPayload) => void | Promise<void>): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let result: CloseResult;
      try {
        result = await this.connect(signal, onMessage);
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        await this.sleep(this.reconnectDelay(failures), signal);
        continue;
      }
      if (signal.aborted) return;
      if (result.code === 4914 || result.code === 4915) throw new QQApiError("QQ Gateway connection is not allowed", result.code);
      if (requiresIdentify(result.code)) this.resume = undefined;
      failures = result.ready ? 0 : failures + 1;
      await this.sleep(this.reconnectDelay(failures), signal);
    }
  }

  private reconnectDelay(failures: number): number {
    const index = failures === 0 ? 0 : Math.min(failures - 1, this.delays.length - 1);
    return this.delays[index] ?? 0;
  }

  private async connect(signal: AbortSignal, onMessage: (message: QQC2CMessage, payload: QQGatewayPayload) => void | Promise<void>): Promise<CloseResult> {
    const [url, accessToken] = await Promise.all([this.options.api.getGatewayUrl(), this.options.tokenManager.get()]);
    const socket = this.socketFactory(url);
    let timer: ReturnType<typeof setInterval> | undefined;
    let awaitingAck = false;
    let ready = false;
    let settled = false;
    let dispatchTail = Promise.resolve();

    return new Promise<CloseResult>((resolve) => {
      const cleanup = (): void => {
        if (timer !== undefined) { this.clearHeartbeat(timer); timer = undefined; }
        signal.removeEventListener("abort", abort);
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", close);
        socket.removeEventListener("error", error);
      };
      const settle = (code: number): void => {
        if (settled) return;
        settled = true;
        cleanup();
        void dispatchTail.finally(() => { resolve({ code, ready }); });
      };
      const abort = (): void => {
        if (socket.readyState === 0) { socket.close(1000, "DSH shutdown"); return; }
        try { socket.close(1000, "DSH shutdown"); } finally { settle(1000); }
      };
      const send = (payload: unknown): void => { if (socket.readyState === 1) socket.send(JSON.stringify(payload)); };
      const heartbeat = (): void => {
        if (awaitingAck) { socket.close(4009, "Heartbeat ACK timeout"); return; }
        send({ op: 1, d: this.resume?.seq ?? null });
        awaitingAck = true;
      };
      const message = (event: QQSocketMessageEvent): void => {
        const payload = decodeGatewayPayload(normalizeSocketData(event.data));
        if (payload === undefined) return;
        if (payload.op === 10) {
          const interval = readHeartbeatInterval(payload.d);
          if (interval === undefined) { socket.close(4002, "Invalid Hello"); return; }
          if (this.resume === undefined) {
            send({ op: 2, d: { token: "QQBot " + accessToken, intents: QQ_C2C_INTENT, shard: [0, 1], properties: { "$os": process.platform, "$browser": "dsh-channel-qq", "$device": "dsh-channel-qq" } } });
          } else {
            send({ op: 6, d: { token: "QQBot " + accessToken, session_id: this.resume.sessionId, seq: this.resume.seq ?? 0 } });
          }
          if (timer !== undefined) this.clearHeartbeat(timer);
          awaitingAck = false;
          timer = this.setHeartbeat(heartbeat, interval);
          return;
        }
        if (payload.op === 11) { awaitingAck = false; return; }
        if (payload.op === 7) { socket.close(4009, "Gateway requested reconnect"); return; }
        if (payload.op === 9) { this.resume = undefined; socket.close(4006, "Invalid session"); return; }
        if (payload.op !== 0) return;
        dispatchTail = dispatchTail.then(async () => {
          if (settled) return;
          if (payload.t === "READY") { const sessionId = readSessionId(payload.d); if (sessionId !== undefined) { this.resume = { sessionId, ...(payload.s === undefined ? {} : { seq: payload.s }) }; ready = true; } }
          else if (payload.t === "RESUMED") ready = true;
          else { const c2c = decodeC2CMessage(payload); if (c2c !== undefined) await onMessage(c2c, payload); }
          if (payload.s !== undefined && this.resume !== undefined) this.resume.seq = payload.s;
        }).catch(() => { socket.close(4009, "Dispatch failed"); });
      };
      const close = (event: QQSocketCloseEvent): void => { settle(event.code); };
      const error = (): void => { socket.close(4009, "Gateway error"); };
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("message", message); socket.addEventListener("close", close); socket.addEventListener("error", error);
      if (signal.aborted) abort();
    });
  }
}

function normalizeSocketData(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return String(value);
}
function readHeartbeatInterval(value: unknown): number | undefined { if (typeof value !== "object" || value === null) return undefined; const interval = (value as { heartbeat_interval?: unknown }).heartbeat_interval; return typeof interval === "number" && Number.isSafeInteger(interval) && interval > 0 ? interval : undefined; }
function readSessionId(value: unknown): string | undefined { if (typeof value !== "object" || value === null) return undefined; const id = (value as { session_id?: unknown }).session_id; return typeof id === "string" && id !== "" ? id : undefined; }
function requiresIdentify(code: number): boolean { return code >= 4000 && code !== 4008 && code !== 4009; }
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve) => { if (signal.aborted || ms === 0) { resolve(); return; } const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }); }

import { createDecipheriv, randomBytes } from "node:crypto";
import type {
  GetConfigResponse,
  GetUpdatesResponse,
  QrCodeResponse,
  QrStatusResponse,
  SendMessageRequest,
} from "./types.js";

export const TENCENT_TRANSPORT_VERSION = "2.4.6";
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const STALE_TOKEN_ERRCODE = -14;

const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

export interface ILinkApiOptions {
  readonly botAgent?: string;
  readonly fetch?: typeof fetch;
}

export class ILinkApi {
  private readonly fetchImpl: typeof fetch;
  private readonly botAgent: string;

  constructor(options: ILinkApiOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.botAgent = sanitizeBotAgent(options.botAgent);
  }

  async startQr(baseUrl: string, localTokenList: readonly string[]): Promise<QrCodeResponse> {
    return this.post<QrCodeResponse>(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3", {
      local_token_list: localTokenList.slice(-10),
    }, undefined, DEFAULT_CONFIG_TIMEOUT_MS, "start QR login");
  }

  async pollQr(baseUrl: string, qrcode: string, verifyCode?: string, signal?: AbortSignal): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    return this.get<QrStatusResponse>(baseUrl, endpoint, 35_000, signal, "poll QR login");
  }

  async getUpdates(baseUrl: string, token: string, cursor: string, timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    try {
      return await this.post<GetUpdatesResponse>(baseUrl, "ilink/bot/getupdates", {
        get_updates_buf: cursor,
        base_info: this.baseInfo(),
      }, token, timeoutMs, "getUpdates", signal);
    } catch (error) {
      if (isAbortError(error)) return { ret: 0, msgs: [], get_updates_buf: cursor };
      throw error;
    }
  }

  async sendMessage(baseUrl: string, token: string, body: SendMessageRequest): Promise<void> {
    const result = await this.post<{ ret?: number; errmsg?: string }>(baseUrl, "ilink/bot/sendmessage", {
      ...body,
      base_info: this.baseInfo(),
    }, token, DEFAULT_API_TIMEOUT_MS, "sendMessage");
    if (result.ret !== undefined && result.ret !== 0) {
      throw new Error(`sendMessage ret=${result.ret} errmsg=${result.errmsg ?? "(none)"}`);
    }
  }

  getConfig(baseUrl: string, token: string, userId: string, contextToken?: string): Promise<GetConfigResponse> {
    return this.post<GetConfigResponse>(baseUrl, "ilink/bot/getconfig", {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: this.baseInfo(),
    }, token, DEFAULT_CONFIG_TIMEOUT_MS, "getConfig");
  }

  async sendTyping(baseUrl: string, token: string, userId: string, ticket: string, status: 1 | 2): Promise<void> {
    await this.post(baseUrl, "ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status,
      base_info: this.baseInfo(),
    }, token, DEFAULT_CONFIG_TIMEOUT_MS, "sendTyping");
  }

  notifyStart(baseUrl: string, token: string): Promise<{ ret?: number; errmsg?: string }> {
    return this.post(baseUrl, "ilink/bot/msg/notifystart", { base_info: this.baseInfo() }, token, DEFAULT_CONFIG_TIMEOUT_MS, "notifyStart");
  }

  notifyStop(baseUrl: string, token: string): Promise<{ ret?: number; errmsg?: string }> {
    return this.post(baseUrl, "ilink/bot/msg/notifystop", { base_info: this.baseInfo() }, token, DEFAULT_CONFIG_TIMEOUT_MS, "notifyStop");
  }

  async downloadMedia(media: { readonly encrypt_query_param?: string; readonly aes_key?: string; readonly full_url?: string }, aeskeyOverride?: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
    const downloadUrl = media.full_url?.trim() || (media.encrypt_query_param ? `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : undefined);
    if (!downloadUrl) throw new Error("WeChat media reference is missing a download URL");
    const response = await this.fetchImpl(downloadUrl, { signal: AbortSignal.timeout(60_000), headers: this.commonHeaders() });
    if (!response.ok) throw new Error(`WeChat media download failed with HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("WeChat media exceeds the transport size limit");
    const ciphertext = Buffer.from(await response.arrayBuffer());
    if (ciphertext.length > maxBytes) throw new Error("WeChat media exceeds the transport size limit");
    const keySource = aeskeyOverride ?? media.aes_key;
    if (!keySource) throw new Error("WeChat media is missing its decryption key");
    const key = decodeAesKey(keySource);
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: TENCENT_TRANSPORT_VERSION, bot_agent: this.botAgent };
  }

  private async get<T>(baseUrl: string, endpoint: string, timeoutMs: number, signal: AbortSignal | undefined, label: string): Promise<T> {
    const response = await this.request(new URL(endpoint, trailingSlash(baseUrl)), {
      method: "GET",
      headers: this.commonHeaders(),
    }, timeoutMs, signal);
    return parseResponse<T>(response, label);
  }

  private async post<T>(baseUrl: string, endpoint: string, body: unknown, token: string | undefined, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
    const headers = new Headers(this.commonHeaders());
    headers.set("Content-Type", "application/json");
    headers.set("AuthorizationType", "ilink_bot_token");
    headers.set("X-WECHAT-UIN", randomWechatUin());
    if (token?.trim()) headers.set("Authorization", `Bearer ${token.trim()}`);
    const response = await this.request(new URL(endpoint, trailingSlash(baseUrl)), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, timeoutMs, signal);
    return parseResponse<T>(response, label);
  }

  private commonHeaders(): HeadersInit {
    return {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    };
  }

  private async request(url: URL, init: RequestInit, timeoutMs: number, external?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    if (external?.aborted) controller.abort();
    else external?.addEventListener("abort", abort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      external?.removeEventListener("abort", abort);
    }
  }
}

export class SessionGuard {
  private readonly pausedUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly pauseMs: number;

  constructor(options: { readonly now?: () => number; readonly pauseMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.pauseMs = options.pauseMs ?? 60 * 60_000;
  }

  pause(accountId: string): void { this.pausedUntil.set(accountId, this.now() + this.pauseMs); }

  remaining(accountId: string): number {
    const until = this.pausedUntil.get(accountId);
    if (until === undefined) return 0;
    const value = until - this.now();
    if (value > 0) return value;
    this.pausedUntil.delete(accountId);
    return 0;
  }

  assertActive(accountId: string): void {
    const remaining = this.remaining(accountId);
    if (remaining > 0) throw new Error(`session paused for accountId=${accountId}, ${Math.ceil(remaining / 60_000)} min remaining (errcode ${STALE_TOKEN_ERRCODE})`);
  }
}

export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw?.trim()) return "DSHChannel/0.4.0";
  const products = raw.trim().split(/\s+/u).filter((value) => /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/u.test(value));
  const result = products.join(" ");
  return result !== "" && Buffer.byteLength(result, "utf8") <= 256 ? result : "DSHChannel/0.4.0";
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function trailingSlash(value: string): string { return value.endsWith("/") ? value : value + "/"; }
function randomWechatUin(): string { return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"); }

function decodeAesKey(encoded: string): Buffer {
  if (/^[0-9a-fA-F]{32}$/u.test(encoded)) return Buffer.from(encoded, "hex");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/u.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new Error("WeChat media decryption key is invalid");
}

async function parseResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  try { return JSON.parse(await response.text()) as T; }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

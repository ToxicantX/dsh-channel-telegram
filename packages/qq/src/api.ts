import type { QQAccessTokenManager } from "./token.js";
import { QQ_API_BASE, QQApiError } from "./types.js";

export interface QQOpenApiClientOptions { readonly tokenManager: QQAccessTokenManager; readonly fetch?: typeof fetch; readonly apiBase?: string; }
export interface QQReplyContext { readonly msgId?: string; readonly eventId?: string; readonly msgSeq?: number; }

export class QQOpenApiClient {
  private readonly request: typeof fetch;
  private readonly apiBase: string;
  constructor(private readonly options: QQOpenApiClientOptions) { this.request = options.fetch ?? fetch; this.apiBase = (options.apiBase ?? QQ_API_BASE).replace(/\/$/u, ""); }

  async getGatewayUrl(): Promise<string> {
    const value = await this.call("/gateway", { method: "GET" });
    if (typeof value !== "object" || value === null || typeof (value as { url?: unknown }).url !== "string") throw new QQApiError("QQ Gateway response was invalid");
    return (value as { url: string }).url;
  }

  async sendC2CText(userOpenId: string, content: string, context: QQReplyContext = {}): Promise<unknown> {
    if (userOpenId === "") throw new Error("QQ user OpenID is required");
    if (content === "") throw new Error("QQ message content is required");
    return this.call("/v2/users/" + encodeURIComponent(userOpenId) + "/messages", {
      method: "POST",
      body: JSON.stringify({
        msg_type: 0, content,
        ...(context.msgId === undefined ? {} : { msg_id: context.msgId }),
        ...(context.eventId === undefined ? {} : { event_id: context.eventId }),
        ...(context.msgSeq === undefined ? {} : { msg_seq: context.msgSeq })
      })
    });
  }

  async sendC2CInputNotify(userOpenId: string, msgId: string, msgSeq: number, seconds = 60): Promise<unknown> {
    return this.call("/v2/users/" + encodeURIComponent(userOpenId) + "/messages", {
      method: "POST", body: JSON.stringify({ msg_type: 6, input_notify: { input_type: 1, input_second: seconds }, msg_id: msgId, msg_seq: msgSeq })
    });
  }

  private async call(path: string, init: RequestInit, retried = false): Promise<unknown> {
    const token = await this.options.tokenManager.get(retried);
    const response = await this.request(this.apiBase + path, { ...init, headers: { authorization: "QQBot " + token, "content-type": "application/json; charset=utf-8", ...init.headers } });
    if (response.status === 401 && !retried) { await response.arrayBuffer().catch(() => undefined); this.options.tokenManager.invalidate(); return this.call(path, init, true); }
    let value: unknown;
    try { value = await response.json(); } catch { value = undefined; }
    if (!response.ok) {
      const code = typeof value === "object" && value !== null ? (value as { code?: number | string }).code : undefined;
      throw new QQApiError("QQ OpenAPI request failed", response.status, code);
    }
    return value;
  }
}

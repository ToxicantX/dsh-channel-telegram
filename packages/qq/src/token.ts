import { QQApiError, QQ_TOKEN_ENDPOINT, type QQAccessToken } from "./types.js";

export interface QQAccessTokenManagerOptions {
  readonly appId: string;
  readonly resolveSecret: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly refreshSkewMs?: number;
  readonly endpoint?: string;
}

interface PendingFetch {
  readonly epoch: number;
  readonly promise: Promise<QQAccessToken>;
}

export class QQAccessTokenManager {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly refreshSkewMs: number;
  private readonly endpoint: string;
  private cached?: QQAccessToken;
  private pending?: PendingFetch;
  private epoch = 0;

  constructor(private readonly options: QQAccessTokenManagerOptions) {
    if (options.appId.trim() === "") throw new Error("QQ AppID is required");
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
    this.endpoint = options.endpoint ?? QQ_TOKEN_ENDPOINT;
    if (!Number.isSafeInteger(this.refreshSkewMs) || this.refreshSkewMs < 0) throw new Error("refreshSkewMs must be a non-negative integer");
  }

  async get(force = false): Promise<string> {
    if (force && this.cached !== undefined) this.invalidate();
    if (!force && this.cached !== undefined && this.cached.expiresAt - this.refreshSkewMs > this.now()) return this.cached.value;
    if (this.pending === undefined || this.pending.epoch !== this.epoch) {
      const epoch = this.epoch;
      const promise = this.fetchToken(epoch).finally(() => {
        if (this.pending?.promise === promise) this.pending = undefined;
      });
      this.pending = { epoch, promise };
    }
    return (await this.pending.promise).value;
  }

  invalidate(): void {
    this.cached = undefined;
    this.epoch += 1;
  }

  private async fetchToken(epoch: number): Promise<QQAccessToken> {
    const secret = await this.options.resolveSecret();
    if (secret.trim() === "") throw new Error("QQ AppSecret is not configured");
    const response = await this.request(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: this.options.appId, clientSecret: secret })
    });
    let value: unknown;
    try { value = await response.json(); } catch { throw new QQApiError("QQ access token response was not JSON", response.status); }
    if (!response.ok || typeof value !== "object" || value === null) throw new QQApiError("QQ access token request failed", response.status);
    const token = (value as { access_token?: unknown }).access_token;
    const rawExpires = (value as { expires_in?: unknown }).expires_in;
    const expiresIn = typeof rawExpires === "number" ? rawExpires : typeof rawExpires === "string" ? Number(rawExpires) : NaN;
    if (typeof token !== "string" || token === "" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new QQApiError("QQ access token response was invalid", response.status);
    }
    const result = { value: token, expiresAt: this.now() + Math.floor(expiresIn * 1000) };
    if (epoch === this.epoch) this.cached = result;
    return result;
  }
}

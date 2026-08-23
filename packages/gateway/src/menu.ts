import { randomBytes } from "node:crypto";

export interface MenuButton {
  readonly text: string;
  readonly callbackData: string;
}

export interface MenuView {
  readonly text: string;
  readonly rows: readonly (readonly MenuButton[])[];
}

export type MenuAction =
  | { readonly type: "root" }
  | { readonly type: "status" }
  | { readonly type: "computers"; readonly page: number }
  | { readonly type: "select-computer"; readonly computerId: string }
  | { readonly type: "projects"; readonly computerId: string; readonly page: number }
  | { readonly type: "select-project"; readonly computerId: string; readonly projectId: string }
  | { readonly type: "sessions"; readonly computerId: string; readonly projectId: string; readonly page: number }
  | { readonly type: "select-session"; readonly computerId: string; readonly projectId: string; readonly sessionId: string }
  | { readonly type: "presets"; readonly computerId: string; readonly projectId: string; readonly page: number }
  | { readonly type: "create-session"; readonly computerId: string; readonly projectId: string; readonly presetId: string };

interface TokenRecord {
  readonly actorId: string;
  readonly conversationId: string;
  readonly action: MenuAction;
  readonly expiresAt: number;
}

export interface CallbackTokenStoreOptions {
  readonly capacity?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly token?: () => string;
}

export class CallbackTokenStore {
  private readonly records = new Map<string, TokenRecord>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly token: () => string;

  constructor(options: CallbackTokenStoreOptions = {}) {
    this.capacity = options.capacity ?? 4096;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.token = options.token ?? (() => randomBytes(9).toString("base64url"));
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new Error("callback capacity must be positive");
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) throw new Error("callback ttl must be positive");
  }

  issue(actorId: string | number, conversationId: string | number, action: MenuAction): string {
    this.prune();
    let token: string | undefined;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.token();
      if (candidate !== "" && !this.records.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (token === undefined) throw new Error("callback token generator did not produce a unique token");
    this.records.set(token, { actorId: String(actorId), conversationId: String(conversationId), action, expiresAt: this.now() + this.ttlMs });
    while (this.records.size > this.capacity) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    return "m:" + token;
  }

  consume(data: string, actorId: string | number, conversationId: string | number): MenuAction | undefined {
    if (!data.startsWith("m:")) return undefined;
    const token = data.slice(2);
    const record = this.records.get(token);
    if (record === undefined) return undefined;
    if (record.expiresAt <= this.now()) {
      this.records.delete(token);
      return undefined;
    }
    if (record.actorId !== String(actorId) || record.conversationId !== String(conversationId)) return undefined;
    this.records.delete(token);
    return record.action;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, record] of this.records) if (record.expiresAt <= now) this.records.delete(token);
  }
}

export function paginate<T>(items: readonly T[], page: number, pageSize = 8): { items: readonly T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(safePage * pageSize, (safePage + 1) * pageSize), page: safePage, pages };
}

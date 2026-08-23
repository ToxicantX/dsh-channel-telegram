import { credentialRef, type CredentialRef } from "@deepseek-ai/dsh-credentials";
import type { Storage } from "@wsxcant/dsh-channel-wechat";

export interface WechatCredentialProvider {
  resolve(ref: CredentialRef): Promise<{ readonly value: string } | undefined>;
  set(ref: CredentialRef, value: string): Promise<void>;
  unset(ref: CredentialRef): Promise<void>;
}

export const WECHAT_STORAGE_KEYS = ["credentials", "cursor", "context_tokens", "typing_tickets"] as const;
export type WechatStorageKey = (typeof WECHAT_STORAGE_KEYS)[number];

interface WechatStoragePayload {
  readonly version: 1;
  readonly values: Partial<Record<WechatStorageKey, unknown>>;
}

/**
 * `@deepseek-ai/dsh-credentials` exposes string refs in rc.1. Keep the
 * namespace/key construction in one place so the serialized grant remains a
 * single credential value without leaking SDK state into settings.
 */
export function credentialKey(namespace: string, name: string): CredentialRef {
  return credentialRef(`${namespace}_${name}`.replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase());
}

export const WECHAT_STORAGE_KEY = credentialKey("dsh-channel-telegram", "wechat-ilink");
export const WECHAT_STORAGE_REF = WECHAT_STORAGE_KEY;

export class DshWechatStorage implements Storage {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly credentials: WechatCredentialProvider, private readonly ref = WECHAT_STORAGE_KEY) {}

  get<T>(name: string): Promise<T | undefined> {
    const key = assertStorageKey(name);
    return this.enqueue(async () => (await this.read()).values[key] as T | undefined);
  }

  set<T>(name: string, value: T): Promise<void> {
    const key = assertStorageKey(name);
    assertSerializable(value);
    return this.enqueue(async () => {
      const payload = await this.read();
      await this.write({ version: 1, values: { ...payload.values, [key]: value } });
    });
  }

  delete(name: string): Promise<void> {
    const key = assertStorageKey(name);
    return this.enqueue(async () => {
      const payload = await this.read();
      if (!(key in payload.values)) return;
      const values = { ...payload.values };
      delete values[key];
      await this.write({ version: 1, values });
    });
  }

  has(name: string): Promise<boolean> {
    const key = assertStorageKey(name);
    return this.enqueue(async () => payloadHas(await this.read(), key));
  }

  clear(): Promise<void> {
    return this.enqueue(() => this.credentials.unset(this.ref));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<WechatStoragePayload> {
    const resolved = await this.credentials.resolve(this.ref);
    if (resolved === undefined) return { version: 1, values: {} };

    let value: unknown;
    try { value = JSON.parse(resolved.value); } catch { throw new Error("Stored WeChat iLink grant payload is invalid"); }
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.values)) {
      throw new Error("Stored WeChat iLink grant payload is invalid");
    }
    for (const key of Object.keys(value.values)) assertStorageKey(key);
    return { version: 1, values: value.values as Partial<Record<WechatStorageKey, unknown>> };
  }

  private write(payload: WechatStoragePayload): Promise<void> {
    return this.credentials.set(this.ref, JSON.stringify(payload));
  }
}

function assertStorageKey(name: string): WechatStorageKey {
  if ((WECHAT_STORAGE_KEYS as readonly string[]).includes(name)) return name as WechatStorageKey;
  throw new Error(`Unsupported WeChat SDK storage key: ${name}`);
}

function payloadHas(payload: WechatStoragePayload, key: WechatStorageKey): boolean {
  return Object.prototype.hasOwnProperty.call(payload.values, key);
}

function assertSerializable(value: unknown): void {
  if (value === undefined) throw new TypeError("WeChat storage values must be JSON-serializable");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("WeChat storage values must be JSON-serializable");
  JSON.parse(encoded);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

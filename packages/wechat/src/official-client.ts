import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_BASE_URL, ILinkApi, SessionGuard, STALE_TOKEN_ERRCODE, isAbortError } from "./official-api.js";
import { FileStorage, MemoryStorage } from "./storage.js";
import {
  MessageItemType,
  MessageState,
  MessageType,
  type Credentials,
  type DownloadedMedia,
  type IncomingMessage,
  type QrLoginCallbacks,
  type SendContent,
  type Storage,
  type WeChatBotOptions,
  type WireMessage,
  type WireMessageItem,
} from "./types.js";

const MAX_QR_REFRESHES = 3;
const CONFIG_TTL_MS = 24 * 60 * 60_000;
const INITIAL_CONFIG_RETRY_MS = 2_000;
const MAX_CONFIG_RETRY_MS = 60 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_TEXT_LENGTH = 4_000;

interface ConfigEntry {
  ticket: string;
  everSucceeded: boolean;
  nextFetchAt: number;
  retryDelayMs: number;
}

export class WeChatBot extends EventEmitter {
  readonly storage: Storage;
  private readonly api: ILinkApi;
  private readonly baseUrl: string;
  private readonly loginCallbacks?: QrLoginCallbacks;
  private readonly handlers: ((message: IncomingMessage) => void | Promise<void>)[] = [];
  private readonly contextTokens = new Map<string, string>();
  private readonly configCache = new Map<string, ConfigEntry>();
  private readonly guard = new SessionGuard();
  private credentials?: Credentials;
  private runPromise?: Promise<void>;
  private pollAbort?: AbortController;
  private loginAbort?: AbortController;
  private stopped = true;

  constructor(options: WeChatBotOptions = {}) {
    super();
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.storage = resolveStorage(options.storage, options.storageDir);
    this.loginCallbacks = options.loginCallbacks;
    this.api = new ILinkApi({ botAgent: options.botAgent, fetch: options.fetch });
  }

  async login(options: { readonly force?: boolean; readonly callbacks?: QrLoginCallbacks } = {}): Promise<Credentials> {
    const stored = await this.storage.get<Credentials>("credentials");
    if (!options.force && isCredentials(stored)) {
      this.credentials = stored;
      this.emit("session:restored", stored);
      return stored;
    }

    const callbacks = options.callbacks ?? this.loginCallbacks ?? {};
    const localTokens = isCredentials(stored) ? [stored.token] : [];
    this.loginAbort?.abort();
    const abort = new AbortController();
    this.loginAbort = abort;
    try {
      const credentials = await this.loginWithQr(callbacks, localTokens, stored, abort.signal);
      await this.storage.set("credentials", credentials);
      await Promise.all([
        this.storage.delete("cursor"),
        this.storage.delete("context_tokens"),
        this.storage.delete("typing_tickets"),
      ]);
      this.contextTokens.clear();
      this.configCache.clear();
      this.credentials = credentials;
      return credentials;
    } finally {
      if (this.loginAbort === abort) this.loginAbort = undefined;
    }
  }

  getCredentials(): Credentials | undefined { return this.credentials; }

  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): this {
    this.handlers.push(handler);
    return this;
  }

  async reply(message: IncomingMessage, content: SendContent): Promise<void> {
    await this.stopTyping(message.userId).catch(() => undefined);
    await this.sendText(message.userId, textContent(content), message._contextToken);
  }

  async send(userId: string, content: SendContent): Promise<void> {
    await this.sendText(userId, textContent(content), this.contextTokens.get(userId));
  }

  async sendTyping(userId: string): Promise<void> { await this.setTyping(userId, 1); }
  async stopTyping(userId: string): Promise<void> { await this.setTyping(userId, 2); }

  async download(message: IncomingMessage): Promise<DownloadedMedia | null> {
    const image = message.images[0] as WireMessageItem | undefined;
    if (image?.image_item?.media) {
      return { data: await this.api.downloadMedia(image.image_item.media, image.image_item.aeskey), type: "image" };
    }
    const file = message.files[0] as WireMessageItem | undefined;
    if (file?.file_item?.media) {
      return { data: await this.api.downloadMedia(file.file_item.media), type: "file", fileName: file.file_item.file_name };
    }
    return null;
  }

  start(): Promise<void> {
    if (this.runPromise !== undefined) return this.runPromise;
    const credentials = this.requireCredentials();
    this.stopped = false;
    const abort = new AbortController();
    this.pollAbort = abort;
    const running = this.runLifecycle(credentials, abort.signal).finally(() => {
      if (this.runPromise === running) this.runPromise = undefined;
      if (this.pollAbort === abort) this.pollAbort = undefined;
    });
    this.runPromise = running;
    return running;
  }

  async run(options: { readonly force?: boolean; readonly callbacks?: QrLoginCallbacks } = {}): Promise<void> {
    await this.login(options);
    await this.start();
  }

  stop(): void {
    this.stopped = true;
    this.loginAbort?.abort();
    this.pollAbort?.abort();
  }

  get isRunning(): boolean { return !this.stopped && this.runPromise !== undefined; }

  private async runLifecycle(credentials: Credentials, signal: AbortSignal): Promise<void> {
    await this.restoreContextTokens();
    try {
      const result = await this.api.notifyStart(credentials.baseUrl, credentials.token);
      if (result.ret !== undefined && result.ret !== 0) this.emitRuntimeError(new Error(`notifyStart ret=${result.ret}`));
    } catch (error) { this.emitRuntimeError(error); }
    this.emit("poll:start");
    try {
      await this.poll(credentials, signal);
    } finally {
      try {
        const result = await this.api.notifyStop(credentials.baseUrl, credentials.token);
        if (result.ret !== undefined && result.ret !== 0) this.emitRuntimeError(new Error(`notifyStop ret=${result.ret}`));
      } catch (error) { this.emitRuntimeError(error); }
      this.stopped = true;
      this.emit("poll:stop");
      this.emit("close");
    }
  }

  private async poll(credentials: Credentials, signal: AbortSignal): Promise<void> {
    let cursor = (await this.storage.get<string>("cursor")) ?? "";
    let timeoutMs = 35_000;
    let failures = 0;
    while (!this.stopped && !signal.aborted) {
      try {
        const response = await this.api.getUpdates(credentials.baseUrl, credentials.token, cursor, timeoutMs, signal);
        if (this.stopped || signal.aborted) break;
        if (response.longpolling_timeout_ms !== undefined && response.longpolling_timeout_ms > 0) timeoutMs = response.longpolling_timeout_ms;
        const apiError = (response.ret !== undefined && response.ret !== 0) || (response.errcode !== undefined && response.errcode !== 0);
        if (apiError) {
          const stale = response.ret === STALE_TOKEN_ERRCODE || response.errcode === STALE_TOKEN_ERRCODE;
          if (stale) {
            this.guard.pause(credentials.accountId);
            this.emit("session:expired");
            failures = 0;
            await abortableDelay(this.guard.remaining(credentials.accountId), signal);
            continue;
          }
          failures += 1;
          this.emitRuntimeError(new Error(`getUpdates ret=${response.ret ?? "none"} errcode=${response.errcode ?? "none"}`));
          await abortableDelay(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
          if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
          continue;
        }
        failures = 0;
        if (response.get_updates_buf) {
          cursor = response.get_updates_buf;
          await this.storage.set("cursor", cursor);
        }
        for (const wire of response.msgs ?? []) {
          const message = parseIncoming(wire);
          if (message === undefined) continue;
          if (message._contextToken) {
            this.contextTokens.set(message.userId, message._contextToken);
            await this.persistContextTokens();
          }
          for (const handler of this.handlers) await handler(message);
          this.emit("message", message);
        }
      } catch (error) {
        if (signal.aborted || (this.stopped && isAbortError(error))) break;
        failures += 1;
        this.emitRuntimeError(error);
        await abortableDelay(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS, signal);
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
      }
    }
  }

  private async loginWithQr(callbacks: QrLoginCallbacks, localTokens: readonly string[], stored: Credentials | undefined, signal: AbortSignal): Promise<Credentials> {
    let refreshes = 0;
    let effectiveBaseUrl = DEFAULT_BASE_URL;
    let verifyCode: string | undefined;
    let verifyRetry = false;
    while (refreshes < MAX_QR_REFRESHES) {
      if (signal.aborted) throw new Error("WeChat login stopped");
      const qr = await this.api.startQr(DEFAULT_BASE_URL, localTokens);
      callbacks.onQrUrl?.(qr.qrcode_img_content);
      while (!signal.aborted) {
        let status;
        try { status = await this.api.pollQr(effectiveBaseUrl, qr.qrcode, verifyCode, signal); }
        catch (error) {
          if (isAbortError(error) && signal.aborted) throw new Error("WeChat login stopped");
          await abortableDelay(1_000, signal);
          continue;
        }
        if (status.status === "wait") continue;
        if (status.status === "scaned") {
          if (verifyCode) { verifyCode = undefined; verifyRetry = false; }
          callbacks.onScanned?.();
          continue;
        }
        if (status.status === "need_verifycode") {
          if (callbacks.onVerifyCode === undefined) throw new Error("WeChat verification code is required");
          verifyCode = String(await callbacks.onVerifyCode(verifyRetry)).trim();
          if (!/^\d+$/u.test(verifyCode)) throw new Error("WeChat verification code must contain digits only");
          verifyRetry = true;
          continue;
        }
        if (status.status === "scaned_but_redirect") {
          if (status.redirect_host) effectiveBaseUrl = `https://${status.redirect_host}`;
          continue;
        }
        if (status.status === "binded_redirect") {
          if (isCredentials(stored)) return stored;
          throw new Error("WeChat account is already bound but no local credentials are available");
        }
        if (status.status === "confirmed") {
          if (!status.bot_token || !status.ilink_bot_id) throw new Error("WeChat login response is missing credentials");
          return {
            token: status.bot_token,
            baseUrl: status.baseurl?.trim() || effectiveBaseUrl || this.baseUrl,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id ?? "",
            savedAt: new Date().toISOString(),
          };
        }
        if (status.status === "expired" || status.status === "verify_code_blocked") {
          callbacks.onExpired?.();
          refreshes += 1;
          verifyCode = undefined;
          verifyRetry = false;
          break;
        }
      }
    }
    throw new Error("WeChat QR login expired too many times");
  }

  private async sendText(userId: string, text: string, contextToken: string | undefined): Promise<void> {
    const credentials = this.requireCredentials();
    this.guard.assertActive(credentials.accountId);
    if (!contextToken) throw new Error(`No WeChat context token for ${userId}`);
    if (text === "") throw new Error("Message text cannot be empty");
    for (const chunk of chunkText(text, MAX_TEXT_LENGTH)) {
      await this.api.sendMessage(credentials.baseUrl, credentials.token, {
        msg: {
          from_user_id: "",
          to_user_id: userId,
          client_id: randomUUID(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: contextToken,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
        },
      });
    }
  }

  private async setTyping(userId: string, status: 1 | 2): Promise<void> {
    const credentials = this.requireCredentials();
    this.guard.assertActive(credentials.accountId);
    const contextToken = this.contextTokens.get(userId);
    if (!contextToken) return;
    const ticket = await this.getTypingTicket(credentials, userId, contextToken);
    if (ticket) await this.api.sendTyping(credentials.baseUrl, credentials.token, userId, ticket, status);
  }

  private async getTypingTicket(credentials: Credentials, userId: string, contextToken: string): Promise<string> {
    const now = Date.now();
    const entry = this.configCache.get(userId);
    if (entry !== undefined && now < entry.nextFetchAt) return entry.ticket;
    let succeeded = false;
    try {
      const response = await this.api.getConfig(credentials.baseUrl, credentials.token, userId, contextToken);
      if (response.ret === 0) {
        const ticket = response.typing_ticket ?? "";
        this.configCache.set(userId, { ticket, everSucceeded: true, nextFetchAt: now + Math.random() * CONFIG_TTL_MS, retryDelayMs: INITIAL_CONFIG_RETRY_MS });
        succeeded = true;
      }
    } catch { /* typing is best effort */ }
    if (!succeeded) {
      const previous = entry?.retryDelayMs ?? INITIAL_CONFIG_RETRY_MS;
      const next = Math.min(previous * 2, MAX_CONFIG_RETRY_MS);
      this.configCache.set(userId, { ticket: entry?.ticket ?? "", everSucceeded: entry?.everSucceeded ?? false, nextFetchAt: now + (entry ? next : INITIAL_CONFIG_RETRY_MS), retryDelayMs: next });
    }
    return this.configCache.get(userId)?.ticket ?? "";
  }

  private requireCredentials(): Credentials {
    if (this.credentials === undefined) throw new Error("WeChat bot is not logged in");
    return this.credentials;
  }

  private async restoreContextTokens(): Promise<void> {
    const stored = await this.storage.get<Record<string, string>>("context_tokens");
    this.contextTokens.clear();
    if (stored === undefined) return;
    for (const [userId, token] of Object.entries(stored)) if (token) this.contextTokens.set(userId, token);
  }

  private persistContextTokens(): Promise<void> { return this.storage.set("context_tokens", Object.fromEntries(this.contextTokens)); }

  private emitRuntimeError(error: unknown): void {
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}

function resolveStorage(storage: WeChatBotOptions["storage"], directory: string | undefined): Storage {
  if (typeof storage === "object") return storage;
  if (storage === "file") return new FileStorage(directory ?? path.resolve(".wechatbot"));
  return new MemoryStorage();
}

function isCredentials(value: unknown): value is Credentials {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Credentials>;
  return [candidate.token, candidate.baseUrl, candidate.accountId, candidate.userId, candidate.savedAt].every((item) => typeof item === "string");
}

function parseIncoming(wire: WireMessage): IncomingMessage | undefined {
  if (wire.message_type !== MessageType.USER || !wire.from_user_id) return undefined;
  const items = wire.item_list ?? [];
  const type = primaryType(items);
  return {
    userId: wire.from_user_id,
    text: extractText(items),
    type,
    timestamp: new Date(wire.create_time_ms ?? Date.now()),
    images: items.filter((item) => item.type === MessageItemType.IMAGE),
    voices: items.filter((item) => item.type === MessageItemType.VOICE),
    files: items.filter((item) => item.type === MessageItemType.FILE),
    videos: items.filter((item) => item.type === MessageItemType.VIDEO),
    raw: wire,
    _contextToken: wire.context_token ?? "",
  };
}

function primaryType(items: readonly WireMessageItem[]): IncomingMessage["type"] {
  switch (items[0]?.type) {
    case MessageItemType.IMAGE: return "image";
    case MessageItemType.VOICE: return "voice";
    case MessageItemType.FILE: return "file";
    case MessageItemType.VIDEO: return "video";
    default: return "text";
  }
}

function extractText(items: readonly WireMessageItem[]): string {
  return items.map((item) => {
    switch (item.type) {
      case MessageItemType.TEXT: return item.text_item?.text ?? "";
      case MessageItemType.IMAGE: return item.image_item?.url ?? "[image]";
      case MessageItemType.VOICE: return item.voice_item?.text ?? "[voice]";
      case MessageItemType.FILE: return item.file_item?.file_name ?? "[file]";
      case MessageItemType.VIDEO: return "[video]";
      default: return "";
    }
  }).filter(Boolean).join("\n");
}

function textContent(content: SendContent): string {
  if (typeof content === "string") return content;
  if ("text" in content) return content.text;
  throw new Error("DSH WeChat transport currently supports text replies only");
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidates = [window.lastIndexOf("\n\n") + 2, window.lastIndexOf("\n") + 1, window.lastIndexOf(" ") + 1];
    const split = candidates.find((value) => value > limit * 0.3) ?? limit;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  try { await delay(ms, undefined, { signal }); } catch (error) { if (!isAbortError(error)) throw error; }
}

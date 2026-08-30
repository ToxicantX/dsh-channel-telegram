import { BoundedIdSet, KeyedSerialQueue, type ControlReply, type DshControlPlane, type DshInboundAttachment, type TurnProgress } from "@wsxcant/dsh-channel-telegram-gateway";
import { WechatProgressReporter } from "./progress.js";
import type { WechatBotLike, WechatIncomingMessage } from "./types.js";

interface NumberedMenu {
  readonly actorId: string;
  readonly expiresAt: number;
  readonly buttons: readonly { readonly text: string; readonly callbackData: string }[];
}

export interface WechatPrivateChannelOptions {
  readonly control: DshControlPlane;
  readonly bot: WechatBotLike;
  readonly allowedUserIds: readonly string[];
  readonly identityLookupEnabled?: boolean;
  readonly menuTtlMs?: number;
  readonly now?: () => number;
  readonly onInbound?: () => void;
  readonly maxAttachmentCount?: number;
  readonly maxAttachmentBytes?: number;
  readonly allowedImageMimeTypes?: readonly string[];
  readonly allowedFileMimeTypes?: readonly string[];
}

const DEFAULT_MAX_ATTACHMENT_COUNT = 1;
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const DEFAULT_FILE_MIME_TYPES = ["text/plain", "text/csv", "application/json", "text/markdown"] as const;
const MEDIA_FAILURE_REPLY = "无法读取你发送的图片或文件，请检查文件类型和大小后重试。";


export class WechatPrivateChannel {
  private readonly allowed: Set<string>;
  private readonly seen = new BoundedIdSet();
  private readonly queues = new KeyedSerialQueue();
  private readonly menus = new Map<string, NumberedMenu>();
  private readonly external = new Map<string, { readonly sessionId: string; readonly turn: number; readonly reporter: WechatProgressReporter }>();
  private readonly now: () => number;
  private readonly menuTtlMs: number;
  private readonly maxAttachmentCount: number;
  private readonly maxAttachmentBytes: number;
  private readonly allowedImageMimeTypes: ReadonlySet<string>;
  private readonly allowedFileMimeTypes: ReadonlySet<string>;
  private readonly unsubscribeProgress: () => void;
  private attached = false;
  private disposed = false;

  constructor(private readonly options: WechatPrivateChannelOptions) {
    const values = options.allowedUserIds.map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 && options.identityLookupEnabled !== true) throw new Error("WeChat allowedUserIds must not be empty unless identity lookup is enabled");
    this.allowed = new Set(values);
    this.now = options.now ?? Date.now;
    this.menuTtlMs = options.menuTtlMs ?? 10 * 60_000;
    this.maxAttachmentCount = options.maxAttachmentCount ?? DEFAULT_MAX_ATTACHMENT_COUNT;
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (!Number.isSafeInteger(this.maxAttachmentCount) || this.maxAttachmentCount < 1) throw new Error("maxAttachmentCount must be positive");
    if (!Number.isSafeInteger(this.maxAttachmentBytes) || this.maxAttachmentBytes < 1) throw new Error("maxAttachmentBytes must be positive");
    this.allowedImageMimeTypes = new Set((options.allowedImageMimeTypes ?? DEFAULT_IMAGE_MIME_TYPES).map((value) => value.toLowerCase()));
    this.allowedFileMimeTypes = new Set((options.allowedFileMimeTypes ?? DEFAULT_FILE_MIME_TYPES).map((value) => value.toLowerCase()));
    this.unsubscribeProgress = options.control.onSessionProgress((event) => this.handleExternalProgress(event.actorId, event.conversationId, event.progress));
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.options.bot.onMessage((message) => this.handleMessage(message));
  }

  handleMessage(message: WechatIncomingMessage): Promise<void> {
    if (this.allowed.has(message.userId) && isDirectTurnMessage(message)) return this.processMessage(message);
    return this.queues.run(message.userId, () => this.processMessage(message));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProgress();
    this.menus.clear();
    this.external.clear();
  }

  private async processMessage(message: WechatIncomingMessage): Promise<void> {
    if (this.disposed) return;
    this.options.onInbound?.();
    const updateId = messageKey(message);
    if (!this.seen.addIfNew(updateId)) return;
    const normalized = message.text.trim().toLowerCase();
    if (!this.allowed.has(message.userId)) {
      if (this.options.identityLookupEnabled === true && message.type === "text" && normalized === "/userid") {
        await this.options.bot.reply(message, "你的微信 iLink 用户 ID：\n" + message.userId);
      }
      return;
    }

    let attachments: readonly DshInboundAttachment[] | undefined;
    if (message.type === "image" || message.type === "file") {
      attachments = await this.downloadAttachments(message);
      if (attachments === undefined) return;
    } else if (message.type !== "text" || message.text.trim() === "") return;

    const menuInput = normalized.startsWith("/") ? normalized.slice(1) : normalized;
    const choice = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
    const shortcut = menuInput === "back" || menuInput === "b" || menuInput === "返回" ? "back" : menuInput === "refresh" || menuInput === "r" || menuInput === "刷新" ? "refresh" : undefined;
    const menu = this.menus.get(message.userId);
    if ((choice !== undefined || shortcut !== undefined) && menu !== undefined) {
      if (menu.expiresAt <= this.now() || menu.actorId !== message.userId) {
        this.menus.delete(message.userId);
        await this.options.bot.reply(message, "菜单已过期，请重新发送 /menu。");
        return;
      }
      const button = shortcut === undefined ? menu.buttons[(choice ?? 0) - 1] : menu.buttons.find((item) => shortcutOfLabel(item.text) === shortcut);
      if (button === undefined) {
        await this.options.bot.reply(message, shortcut === undefined ? "无效的菜单选项，请回复列表中的数字、/back 或 /refresh。" : "当前菜单没有该操作，请重新发送 /menu。");
        return;
      }
      const result = await this.options.control.handleCallback({ updateId: updateId + ":choice:" + (shortcut ?? String(choice)), actorId: message.userId, conversationId: message.userId, data: button.callbackData });
      if (this.disposed) return;
      if (result.view !== undefined) await this.sendReply(message, result.view);
      else await this.options.bot.reply(message, result.answer);
      return;
    }

    const reporter = new WechatProgressReporter({ bot: this.options.bot, userId: message.userId, message, shouldStop: () => this.disposed });
    const replies = await this.options.control.handle({ updateId, actorId: message.userId, conversationId: message.userId, text: message.text, attachments }, (progress) => reporter.update(progress));
    if (this.disposed) return;
    for (const reply of replies) await this.sendReply(message, reply);
  }

  private async downloadAttachments(message: WechatIncomingMessage): Promise<readonly DshInboundAttachment[] | undefined> {
    const declaredCount = message.images.length + message.files.length;
    if (declaredCount < 1 || declaredCount > this.maxAttachmentCount) {
      await this.mediaFailure(message);
      return undefined;
    }
    const declaredSize = declaredMediaSize(message);
    if (declaredSize !== undefined && declaredSize > this.maxAttachmentBytes) {
      await this.mediaFailure(message);
      return undefined;
    }
    try {
      const media = await this.options.bot.download(message);
      if (media === null || (media.type !== "image" && media.type !== "file")) throw new Error("unsupported media");
      if (media.type !== message.type) throw new Error("media type mismatch");
      if (media.data.byteLength > this.maxAttachmentBytes) throw new Error("media too large");
      const mediaType = detectMediaType(media.type, media.fileName, media.data);
      const allowed = media.type === "image" ? this.allowedImageMimeTypes : this.allowedFileMimeTypes;
      if (mediaType === undefined || !allowed.has(mediaType)) throw new Error("media type is not allowed");
      return [{ type: media.type, data: media.data, mediaType, name: media.fileName }];
    } catch {
      await this.mediaFailure(message);
      return undefined;
    }
  }

  private async mediaFailure(message: WechatIncomingMessage): Promise<void> {
    try { await this.options.bot.reply(message, MEDIA_FAILURE_REPLY); } catch { /* delivery failure is contained */ }
  }

  private async sendReply(message: WechatIncomingMessage, reply: ControlReply): Promise<void> {
    if (typeof reply === "string") { await this.options.bot.reply(message, reply); return; }
    const buttons = reply.rows.flat().map((button) => ({ text: button.text, callbackData: button.callbackData }));
    this.menus.set(message.userId, { actorId: message.userId, buttons, expiresAt: this.now() + this.menuTtlMs });
    const lines = buttons.map((button, index) => String(index + 1) + ". " + button.text);
    await this.options.bot.reply(message, [reply.text, "", ...lines, "", "请回复数字、/back 或 /refresh。"].join("\n"));
  }

  private async handleExternalProgress(actorId: string, conversationId: string, progress: TurnProgress): Promise<void> {
    if (this.disposed || !this.allowed.has(actorId) || actorId !== conversationId) return;
    await this.queues.run(actorId, async () => {
      if (this.disposed || !this.allowed.has(actorId)) return;
      const turn = progressTurn(progress);
      if (turn === undefined) return;
      let current = this.external.get(conversationId);
      if (current === undefined || current.sessionId !== progress.sessionId || current.turn !== turn) {
        current = { sessionId: progress.sessionId, turn, reporter: new WechatProgressReporter({ bot: this.options.bot, userId: actorId, shouldStop: () => this.disposed }) };
        this.external.set(conversationId, current);
      }
      await current.reporter.update(progress);
      if (progress.type === "turn-end" || progress.type === "failed") if (this.external.get(conversationId) === current) this.external.delete(conversationId);
    });
  }
}

function messageKey(message: WechatIncomingMessage): string {
  const raw = message.raw;
  return [message.userId, raw.message_id ?? "", raw.seq ?? "", raw.session_id ?? "", message.timestamp.getTime()].join(":");
}

function progressTurn(progress: TurnProgress): number | undefined {
  switch (progress.type) {
    case "turn-start": case "assistant-delta": case "assistant-message": case "tool-start": case "tool-end": return progress.turn;
    case "turn-end": return progress.result.turn;
    default: return undefined;
  }
}

function isDirectTurnMessage(message: WechatIncomingMessage): boolean {
  if (message.type === "image" || message.type === "file") return true;
  if (message.type !== "text") return false;
  const normalized = message.text.trim().toLowerCase();
  if (normalized === "" || normalized.startsWith("/") || /^\d+$/u.test(normalized)) return false;
  return normalized !== "back" && normalized !== "b" && normalized !== "返回" && normalized !== "refresh" && normalized !== "r" && normalized !== "刷新";
}

function shortcutOfLabel(value: string): "back" | "refresh" | undefined { const normalized = value.trim().toLowerCase(); return normalized === "back" || normalized === "返回" ? "back" : normalized === "refresh" || normalized === "刷新" ? "refresh" : undefined; }

function declaredMediaSize(message: WechatIncomingMessage): number | undefined {
  const item = message.raw.item_list?.find((candidate) => candidate.type === 2 || candidate.type === 4);
  const raw = item?.type === 2 ? item.image_item : item?.file_item;
  const value = raw && "len" in raw ? raw.len : raw && "hd_size" in raw ? raw.hd_size : raw && "mid_size" in raw ? raw.mid_size : undefined;
  const size = typeof value === "string" ? Number(value) : value;
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function detectMediaType(kind: "image" | "file", fileName: string | undefined, data: Uint8Array): string | undefined {
  if (kind === "image") return sniffImageMime(data);
  const extension = fileName?.toLowerCase().match(/\.([a-z0-9]{1,12})$/u)?.[1];
  return extension === "txt" ? "text/plain" : extension === "csv" ? "text/csv" : extension === "json" ? "application/json" : extension === "md" ? "text/markdown" : undefined;
}

function sniffImageMime(data: Uint8Array): string | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) return "image/gif";
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return "image/webp";
  return undefined;
}

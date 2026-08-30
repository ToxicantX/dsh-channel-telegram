import { Bot, InlineKeyboard, type Context } from "grammy";
import type { GatewayReply, TelegramGateway } from "./gateway.js";
import type { MenuView } from "./menu.js";
import type { DshInboundAttachment, TurnProgress } from "./ports.js";
import { ProgressMessageEditor, ProgressMessageUnavailableError } from "./progress.js";

const TELEGRAM_TEXT_LIMIT = 4096;

export interface TelegramInboundMetadata {
  readonly updateId: number;
  readonly kind: "callback" | "text";
  readonly userId?: number;
  readonly chatId?: number;
  readonly chatType?: string;
}

export interface TelegramBotOptions {
  readonly progressEditIntervalMs?: number;
  readonly onInbound?: (metadata: TelegramInboundMetadata) => void;
}

export function createTelegramBot(token: string, gateway: TelegramGateway, options: TelegramBotOptions = {}): Bot {
  const bot = new Bot(token);
  const relayEditors = new Map<number, { readonly sessionId: string; readonly turn: number; readonly editor: ProgressMessageEditor }>();

  const disposeRelay = gateway.onSessionProgress(async ({ chatId, progress }) => {
    const turn = turnOf(progress);
    if (turn === undefined) return;
    let current = relayEditors.get(chatId);
    if (current === undefined || current.sessionId !== progress.sessionId || current.turn !== turn) {
      current?.editor.dispose();
      current = {
        sessionId: progress.sessionId,
        turn,
        editor: botProgressEditor(bot, chatId, options.progressEditIntervalMs)
      };
      relayEditors.set(chatId, current);
    }
    try {
      await current.editor.update(progress);
    } catch {
      current.editor.dispose();
      if (relayEditors.get(chatId) === current) relayEditors.delete(chatId);
      return;
    }
    if (progress.type === "turn-end" || progress.type === "failed") {
      current.editor.dispose();
      if (relayEditors.get(chatId) === current) relayEditors.delete(chatId);
    }
  });
  gateway.onDispose(() => {
    disposeRelay();
    for (const current of relayEditors.values()) current.editor.dispose();
    relayEditors.clear();
  });

  bot.use(async (ctx, next) => {
    const callbackMessage = ctx.callbackQuery?.message;
    const message = ctx.message;
    options.onInbound?.({
      updateId: ctx.update.update_id,
      kind: ctx.callbackQuery === undefined ? "text" : "callback",
      userId: ctx.from?.id,
      chatId: callbackMessage?.chat.id ?? message?.chat.id,
      chatType: callbackMessage?.chat.type ?? message?.chat.type
    });
    await next();
  });

  bot.on("callback_query:data", async (ctx) => {
    const message = ctx.callbackQuery.message;
    if (message === undefined) {
      await ctx.answerCallbackQuery({ text: "This menu is unavailable." });
      return;
    }
    await ctx.answerCallbackQuery();
    const result = await gateway.handleCallback({
      updateId: ctx.update.update_id,
      chatId: message.chat.id,
      chatType: message.chat.type,
      userId: ctx.from.id,
      data: ctx.callbackQuery.data
    });
    if (result.view !== undefined) await editMenu(ctx, result.view);
    else await editMenu(ctx, { text: result.answer, rows: [] });
  });

  bot.on("message:photo", async (ctx) => {
    if (!gateway.accepts({ chatType: ctx.chat.type, userId: ctx.from.id })) return;
    const photo = ctx.message.photo.at(-1);
    if (photo === undefined) return;
    try {
      const attachment = await downloadTelegramAttachment(bot, token, photo.file_id, "image", undefined, "image/jpeg");
      await handleTelegramMessage(ctx, gateway, ctx.message.caption ?? "", [attachment], options.progressEditIntervalMs);
    } catch { await ctx.reply("图片下载失败，请重试。"); }
  });

  bot.on("message:document", async (ctx) => {
    if (!gateway.accepts({ chatType: ctx.chat.type, userId: ctx.from.id })) return;
    const document = ctx.message.document;
    try {
      const mediaType = document.mime_type ?? mimeTypeFromName(document.file_name);
      if (!isSupportedTelegramMediaType(mediaType)) throw new Error("Unsupported Telegram media type");
      const attachment = await downloadTelegramAttachment(bot, token, document.file_id, mediaType.startsWith("image/") ? "image" : "file", document.file_name, mediaType);
      await handleTelegramMessage(ctx, gateway, ctx.message.caption ?? "", [attachment], options.progressEditIntervalMs);
    } catch { await ctx.reply("附件下载失败，请检查文件类型和大小后重试。"); }
  });

  bot.on("message:text", async (ctx) => {
    await handleTelegramMessage(ctx, gateway, ctx.message.text, undefined, options.progressEditIntervalMs);
  });
  return bot;
}

async function handleTelegramMessage(ctx: Context, gateway: TelegramGateway, text: string, attachments: readonly DshInboundAttachment[] | undefined, intervalMs: number | undefined): Promise<void> {
  if (ctx.chat === undefined || ctx.from === undefined) return;
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const userId = ctx.from.id;
  const progress = new ProgressMessageEditor({
    send: async (value) => ({ messageId: (await ctx.reply(value)).message_id }),
    edit: async (messageId, value) => {
      try { await ctx.api.editMessageText(chatId, messageId, value); }
      catch (error) { if (isNotModified(error)) return; if (isUnavailableEdit(error)) throw new ProgressMessageUnavailableError("Telegram progress message is unavailable", { cause: error }); throw error; }
    }
  }, { intervalMs });
  const replies = await gateway.handle({ updateId: ctx.update.update_id, chatId, chatType, userId, text, attachments }, (event) => progress.update(event));
  for (const reply of replies) await sendReply(ctx, reply);
}

function botProgressEditor(bot: Bot, chatId: number, intervalMs: number | undefined): ProgressMessageEditor {
  return new ProgressMessageEditor({
    send: async (text) => ({ messageId: (await bot.api.sendMessage(chatId, text)).message_id }),
    edit: async (messageId, text) => {
      try {
        await bot.api.editMessageText(chatId, messageId, text);
      } catch (error) {
        if (isNotModified(error)) return;
        if (isUnavailableEdit(error)) throw new ProgressMessageUnavailableError("Telegram progress message is unavailable", { cause: error });
        throw error;
      }
    }
  }, { intervalMs });
}

const TELEGRAM_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

async function downloadTelegramAttachment(bot: Bot, token: string, fileId: string, type: "image" | "file", name: string | undefined, mediaType: string): Promise<DshInboundAttachment> {
  const file = await bot.api.getFile(fileId);
  if (file.file_path === undefined || file.file_path === "") throw new Error("Telegram file path is unavailable");
  const response = await fetch("https://api.telegram.org/file/bot" + token + "/" + file.file_path);
  if (!response.ok) throw new Error("Telegram file download failed");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > TELEGRAM_MAX_ATTACHMENT_BYTES) throw new Error("Telegram file is too large");
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > TELEGRAM_MAX_ATTACHMENT_BYTES) throw new Error("Telegram file is too large");
  return { type, data, mediaType, ...(name === undefined ? {} : { name }) };
}

function isSupportedTelegramMediaType(value: string): boolean { return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif" || value === "text/plain" || value === "text/csv" || value === "application/json" || value === "text/markdown"; }

function mimeTypeFromName(name: string | undefined): string {
  const extension = name?.toLowerCase().match(/\.([a-z0-9]{1,12})$/u)?.[1];
  return extension === "txt" ? "text/plain" : extension === "csv" ? "text/csv" : extension === "json" ? "application/json" : extension === "md" ? "text/markdown" : extension === "pdf" ? "application/pdf" : extension === "zip" ? "application/zip" : extension === "gz" ? "application/gzip" : extension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : extension === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : extension === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/octet-stream";
}

function turnOf(progress: TurnProgress): number | undefined {
  switch (progress.type) {
    case "turn-start":
    case "assistant-delta":
    case "assistant-message":
    case "tool-start":
    case "tool-end": return progress.turn;
    case "turn-end": return progress.result.turn;
    case "queued":
    case "failed": return undefined;
  }
}

export async function sendTelegramDiagnosticReady(bot: Bot, userIds: readonly number[]): Promise<void> {
  await Promise.all(userIds.map((userId) => bot.api.sendMessage(userId, "DSH Telegram diagnostics online. Send /start to open the target menu.")));
}

export async function registerTelegramCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "打开主机、项目和会话菜单" },
    { command: "menu", description: "显示当前目标和选择菜单" },
    { command: "computers", description: "选择主机" },
    { command: "projects", description: "选择项目" },
    { command: "sessions", description: "选择会话" },
    { command: "status", description: "显示当前目标状态" },
    { command: "new", description: "在所选项目中新建会话" },
    { command: "stop", description: "停止当前会话任务" }
  ], { scope: { type: "all_private_chats" } });
}

async function sendReply(ctx: Context, reply: GatewayReply): Promise<void> {
  if (typeof reply !== "string") {
    await ctx.reply(reply.text, { reply_markup: keyboard(reply) });
    return;
  }
  for (let index = 0; index < reply.length; index += TELEGRAM_TEXT_LIMIT) await ctx.reply(reply.slice(index, index + TELEGRAM_TEXT_LIMIT));
}

async function editMenu(ctx: Context, view: MenuView): Promise<void> {
  try {
    await ctx.editMessageText(view.text, { reply_markup: keyboard(view) });
  } catch (error) {
    if (isNotModified(error)) return;
    if (!isUnavailableEdit(error)) throw error;
    await ctx.reply(view.text, { reply_markup: keyboard(view) });
  }
}

function keyboard(view: MenuView): InlineKeyboard {
  const result = new InlineKeyboard();
  for (const row of view.rows) {
    if (row.length === 0) continue;
    for (const button of row) result.text(button.text, button.callbackData);
    result.row();
  }
  return result;
}

function isNotModified(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("message is not modified");
}

function isUnavailableEdit(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("message to edit not found") || message.includes("message can't be edited");
}

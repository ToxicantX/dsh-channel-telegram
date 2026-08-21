import { Bot, InlineKeyboard, type Context } from "grammy";
import type { GatewayReply, TelegramGateway } from "./gateway.js";
import type { MenuView } from "./menu.js";
import { ProgressMessageEditor, ProgressMessageUnavailableError } from "./progress.js";

const TELEGRAM_TEXT_LIMIT = 4096;

export interface TelegramBotOptions {
  readonly progressEditIntervalMs?: number;
}

export function createTelegramBot(token: string, gateway: TelegramGateway, options: TelegramBotOptions = {}): Bot {
  const bot = new Bot(token);

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

  bot.on("message:text", async (ctx) => {
    const progress = new ProgressMessageEditor({
      send: async (text) => ({ messageId: (await ctx.reply(text)).message_id }),
      edit: async (messageId, text) => {
        try {
          await ctx.api.editMessageText(ctx.chat.id, messageId, text);
        } catch (error) {
          if (isNotModified(error)) return;
          if (isUnavailableEdit(error)) throw new ProgressMessageUnavailableError("Telegram progress message is unavailable", { cause: error });
          throw error;
        }
      }
    }, { intervalMs: options.progressEditIntervalMs });
    const replies = await gateway.handle({
      updateId: ctx.update.update_id,
      chatId: ctx.chat.id,
      chatType: ctx.chat.type,
      userId: ctx.from.id,
      text: ctx.message.text
    }, (event) => progress.update(event));
    for (const reply of replies) await sendReply(ctx, reply);
  });
  return bot;
}

export async function registerTelegramCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands([
    { command: "start", description: "Open computer, project, and session menu" },
    { command: "menu", description: "Show the current target and selectors" },
    { command: "computers", description: "Select a computer" },
    { command: "projects", description: "Select a project" },
    { command: "sessions", description: "Select a session" },
    { command: "status", description: "Show the current target status" },
    { command: "new", description: "Create a session in the selected project" },
    { command: "stop", description: "Stop the current session turn" }
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

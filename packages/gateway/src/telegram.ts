import { Bot, InlineKeyboard, type Context } from "grammy";
import type { GatewayReply, TelegramGateway } from "./gateway.js";
import type { MenuView } from "./menu.js";
import { ProgressMessageEditor } from "./progress.js";

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
    const result = await gateway.handleCallback({
      updateId: ctx.update.update_id,
      chatId: message.chat.id,
      chatType: message.chat.type,
      userId: ctx.from.id,
      data: ctx.callbackQuery.data
    });
    await ctx.answerCallbackQuery({ text: result.answer });
    if (result.view !== undefined) await editMenu(ctx, result.view);
  });

  bot.on("message:text", async (ctx) => {
    const progress = new ProgressMessageEditor({
      send: async (text) => ({ messageId: (await ctx.reply(text)).message_id }),
      edit: async (messageId, text) => {
        try {
          await ctx.api.editMessageText(ctx.chat.id, messageId, text);
        } catch (error) {
          if (!isNotModified(error)) throw error;
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
    if (!isNotModified(error)) throw error;
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

import { Bot } from "grammy";
import type { TelegramGateway } from "./gateway.js";

const TELEGRAM_TEXT_LIMIT = 4096;

export function createTelegramBot(token: string, gateway: TelegramGateway): Bot {
  const bot = new Bot(token);
  bot.on("message:text", async (ctx) => {
    const replies = await gateway.handle({
      updateId: ctx.update.update_id,
      chatId: ctx.chat.id,
      chatType: ctx.chat.type,
      userId: ctx.from.id,
      text: ctx.message.text
    });
    for (const reply of replies) {
      for (let index = 0; index < reply.length; index += TELEGRAM_TEXT_LIMIT) {
        await ctx.reply(reply.slice(index, index + TELEGRAM_TEXT_LIMIT));
      }
    }
  });
  return bot;
}

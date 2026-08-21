import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import { TelegramGateway } from "./gateway.js";
import type { DshPort, TurnProgressListener, TurnResult } from "./ports.js";
import { createTelegramBot, registerTelegramCommands, sendTelegramDiagnosticReady } from "./telegram.js";

class FakePort implements DshPort {
  computerGate?: Promise<void>;
  async listComputers() {
    await this.computerGate;
    return [{ id: "local", title: "Local DSH", status: "online" }] as const;
  }
  async listProjects() { return [{ id: "p1", title: "Project", path: "C:/project", status: "online" }] as const; }
  async listSessions() { return [{ id: "s1", title: "Session", status: "idle" }] as const; }
  async createSession() { return { id: "s2", title: "New", status: "idle" } as const; }
  async send(sessionId: string, _text: string, onProgress?: TurnProgressListener): Promise<TurnResult> {
    onProgress?.({ type: "turn-start", sessionId, turn: 9 });
    onProgress?.({ type: "tool-start", sessionId, turn: 9, step: 1, callId: "c1", name: "read" });
    onProgress?.({ type: "tool-end", sessionId, turn: 9, step: 1, callId: "c1", name: "read", failed: false });
    const result = { text: "dsh-channel-telegram", reason: "completed", turn: 9 } as const;
    onProgress?.({ type: "turn-end", sessionId, result });
    return result;
  }
  async status() { return "idle" as const; }
  async stop() { return true; }
}

interface ApiCall { method: string; payload: Record<string, unknown> }
const chat = { id: 42, type: "private" as const, first_name: "User" };
const from = { id: 42, is_bot: false, first_name: "User" };

function messageUpdate(updateId: number, text: string): Update {
  return { update_id: updateId, message: { message_id: updateId, date: 1, chat, from, text } } as Update;
}
function callbackUpdate(updateId: number, data: string): Update {
  return { update_id: updateId, callback_query: { id: "cb" + String(updateId), chat_instance: "ci", from, data, message: { message_id: 100, date: 1, chat, text: "menu" } } } as Update;
}
function firstCallback(payload: Record<string, unknown>): string {
  const markup = payload.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  return markup.inline_keyboard[0]![0]!.callback_data;
}

describe("createTelegramBot", () => {
  it("answers callbacks, edits the menu, and finalizes one scoped progress message", async () => {
    const calls: ApiCall[] = [];
    const inbound: unknown[] = [];
    let messageId = 100;
    const port = new FakePort();
    const gateway = new TelegramGateway(port, { allowedUserIds: [42] });
    const bot = createTelegramBot("123456:fake-token", gateway, { progressEditIntervalMs: 250, onInbound: (metadata) => { inbound.push(metadata); } });
    bot.api.config.use(async (_previous, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "getMe") return { ok: true, result: { id: 999, is_bot: true, first_name: "Bot", username: "test_bot" } } as never;
      if (method === "answerCallbackQuery" || method === "setMyCommands") return { ok: true, result: true } as never;
      const text = String((payload as { text?: string }).text ?? "");
      return { ok: true, result: { message_id: ++messageId, date: 1, chat, text } } as never;
    });
    await bot.init();
    await registerTelegramCommands(bot);
    await sendTelegramDiagnosticReady(bot, [42]);
    const readyCall = calls.findLast((call) => call.method === "sendMessage")!;
    expect(readyCall.payload.chat_id).toBe(42);
    expect(String(readyCall.payload.text)).toContain("diagnostics online");
    const commandCall = calls.findLast((call) => call.method === "setMyCommands")!;
    expect(commandCall.payload.scope).toEqual({ type: "all_private_chats" });
    expect(commandCall.payload.commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: "start" }), expect.objectContaining({ command: "sessions" })]));

    await bot.handleUpdate(messageUpdate(1, "/start"));
    const menuCall = calls.findLast((call) => call.method === "sendMessage")!;
    let releaseComputerLookup = () => undefined;
    port.computerGate = new Promise<void>((resolve) => { releaseComputerLookup = resolve; });
    const openingComputers = bot.handleUpdate(callbackUpdate(2, firstCallback(menuCall.payload)));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.at(-1)?.method).toBe("answerCallbackQuery");
    releaseComputerLookup();
    await openingComputers;
    expect(calls.slice(-2).map((call) => call.method)).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(inbound.slice(0, 2)).toEqual([
      { updateId: 1, kind: "text", userId: 42, chatId: 42, chatType: "private" },
      { updateId: 2, kind: "callback", userId: 42, chatId: 42, chatType: "private" }
    ]);
    expect(inbound[0]).not.toHaveProperty("text");
    expect(inbound[1]).not.toHaveProperty("data");

    let edit = calls.findLast((call) => call.method === "editMessageText")!;
    await bot.handleUpdate(callbackUpdate(3, firstCallback(edit.payload)));
    edit = calls.findLast((call) => call.method === "editMessageText")!;
    await bot.handleUpdate(callbackUpdate(4, firstCallback(edit.payload)));
    edit = calls.findLast((call) => call.method === "editMessageText")!;
    await bot.handleUpdate(callbackUpdate(5, firstCallback(edit.payload)));
    edit = calls.findLast((call) => call.method === "editMessageText")!;
    expect(String(edit.payload.text)).toContain("Session: s1");

    const beforeTurn = calls.length;
    await bot.handleUpdate(messageUpdate(6, "read package name"));
    const turnCalls = calls.slice(beforeTurn);
    expect(turnCalls[0]?.method).toBe("sendMessage");
    expect(String(turnCalls[0]?.payload.text)).toContain("Queued");
    expect(turnCalls.at(-1)?.method).toBe("editMessageText");
    expect(String(turnCalls.at(-1)?.payload.text)).toContain("dsh-channel-telegram");
    expect(String(turnCalls.at(-1)?.payload.text)).toContain("Session: s1");
  });
});

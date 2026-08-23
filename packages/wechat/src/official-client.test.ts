import { describe, expect, it } from "vitest";
import { MemoryStorage, WeChatBot, type Credentials, type IncomingMessage } from "./index.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("official WeChat transport client", () => {
  it("completes the official QR login flow and persists returned credentials", async () => {
    const storage = new MemoryStorage(); const qrUrls: string[] = []; const bodies: unknown[] = [];
    const bot = new WeChatBot({
      storage,
      fetch: async (input, init) => {
        const endpoint = new URL(String(input)).pathname;
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        if (endpoint.endsWith("/get_bot_qrcode")) return response({ qrcode: "opaque-qr", qrcode_img_content: "https://qr.example/value" });
        if (endpoint.endsWith("/get_qrcode_status")) return response({ status: "confirmed", bot_token: "new-token", ilink_bot_id: "bot@im.bot", ilink_user_id: "owner@im.wechat", baseurl: "https://route.example" });
        throw new Error("unexpected endpoint " + endpoint);
      },
    });

    const result = await bot.login({ force: true, callbacks: { onQrUrl: (url) => qrUrls.push(url) } });

    expect(qrUrls).toEqual(["https://qr.example/value"]);
    expect(result).toMatchObject({ token: "new-token", accountId: "bot@im.bot", userId: "owner@im.wechat", baseUrl: "https://route.example" });
    expect(await storage.get("credentials")).toEqual(result);
    expect(bodies[0]).toEqual({ local_token_list: [] });
  });

  it("submits the phone verification code through the official QR status query", async () => {
    const statuses = [
      { status: "need_verifycode" },
      { status: "scaned" },
      { status: "confirmed", bot_token: "token", ilink_bot_id: "bot", ilink_user_id: "owner" },
    ];
    const statusUrls: string[] = []; const retries: boolean[] = [];
    const bot = new WeChatBot({
      storage: new MemoryStorage(),
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/get_bot_qrcode")) return response({ qrcode: "qr", qrcode_img_content: "https://qr.example" });
        statusUrls.push(url.toString());
        return response(statuses.shift());
      },
    });

    await bot.login({ force: true, callbacks: { onVerifyCode: (retry) => { retries.push(retry); return "123456"; } } });

    expect(retries).toEqual([false]);
    expect(statusUrls[1]).toContain("verify_code=123456");
  });

  it("runs notifyStart, persists the cursor, dispatches inbound, and runs notifyStop", async () => {
    const storage = new MemoryStorage();
    const credentials: Credentials = {
      token: "secret",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "bot@im.bot",
      userId: "owner@im.wechat",
      savedAt: "2026-08-23T00:00:00.000Z",
    };
    await storage.set("credentials", credentials);
    const endpoints: string[] = [];
    let updates = 0;
    let configFetches = 0;
    const bot = new WeChatBot({
      storage,
      fetch: async (input, init) => {
        const endpoint = new URL(String(input)).pathname;
        endpoints.push(endpoint);
        if (endpoint.endsWith("/getupdates")) {
          updates += 1;
          if (updates === 1) {
            return response({
              ret: 0,
              get_updates_buf: "cursor-1",
              msgs: [{
                seq: 7,
                message_id: 8,
                from_user_id: "user@im.wechat",
                to_user_id: "bot@im.bot",
                client_id: "client",
                create_time_ms: 1_000,
                message_type: 1,
                message_state: 0,
                context_token: "context",
                item_list: [{ type: 1, text_item: { text: "hello" } }],
              }],
            });
          }
          await new Promise<void>((resolve) => {
            init?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new DOMException("aborted", "AbortError");
        }
        if (endpoint.endsWith("/getconfig")) {
          configFetches += 1;
          return response({ ret: 0, typing_ticket: "ticket" });
        }
        return response({ ret: 0 });
      },
    });
    const received = new Promise<IncomingMessage>((resolve) => bot.onMessage(resolve));

    await bot.login();
    const running = bot.start();
    const message = await received;
    expect(message.text).toBe("hello");
    await bot.sendTyping(message.userId);
    await bot.stopTyping(message.userId);
    bot.stop();
    await running;

    expect(await storage.get("cursor")).toBe("cursor-1");
    expect(await storage.get("context_tokens")).toEqual({ "user@im.wechat": "context" });
    expect(configFetches).toBe(1);
    expect(endpoints[0]).toBe("/ilink/bot/msg/notifystart");
    expect(endpoints).toContain("/ilink/bot/getupdates");
    expect(endpoints.at(-1)).toBe("/ilink/bot/msg/notifystop");
  });
});

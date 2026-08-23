import { describe, expect, it } from "vitest";
import { ILinkApi, SessionGuard } from "./official-api.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Tencent v2.4.6 iLink protocol", () => {
  it("sends official headers, base_info, and getUpdates cursor", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = new ILinkApi({
      botAgent: "DSHChannel/0.4.0",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return response({ ret: 0, msgs: [], get_updates_buf: "next", longpolling_timeout_ms: 1200 });
      },
    });

    const result = await api.getUpdates("https://ilinkai.weixin.qq.com", "secret", "cursor");

    expect(result.get_updates_buf).toBe("next");
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("AuthorizationType")).toBe("ilink_bot_token");
    expect(headers.get("iLink-App-Id")).toBe("bot");
    expect(headers.get("iLink-App-ClientVersion")).toBe(String((2 << 16) | (4 << 8) | 6));
    expect(headers.get("X-WECHAT-UIN")).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      get_updates_buf: "cursor",
      base_info: { channel_version: "2.4.6", bot_agent: "DSHChannel/0.4.0" },
    });
  });

  it("uses the official lifecycle endpoints", async () => {
    const endpoints: string[] = [];
    const api = new ILinkApi({
      fetch: async (input) => {
        endpoints.push(new URL(String(input)).pathname);
        return response({ ret: 0 });
      },
    });

    await api.notifyStart("https://ilinkai.weixin.qq.com", "secret");
    await api.notifyStop("https://ilinkai.weixin.qq.com", "secret");

    expect(endpoints).toEqual(["/ilink/bot/msg/notifystart", "/ilink/bot/msg/notifystop"]);
  });

  it("pauses a stale session for the configured cooldown", () => {
    let now = 1_000;
    const guard = new SessionGuard({ now: () => now, pauseMs: 60_000 });
    guard.pause("account");
    expect(() => guard.assertActive("account")).toThrow(/errcode -14/u);
    now += 60_000;
    expect(() => guard.assertActive("account")).not.toThrow();
  });
});

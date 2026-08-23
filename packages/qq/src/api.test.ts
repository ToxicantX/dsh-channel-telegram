import { describe, expect, it } from "vitest";
import { QQOpenApiClient } from "./api.js";
import { QQAccessTokenManager } from "./token.js";
import { QQApiError } from "./types.js";

function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status }); }

describe("QQOpenApiClient", () => {
  it("discovers Gateway and sends passive C2C messages with monotonic sequence", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tokenManager = new QQAccessTokenManager({ appId: "app", resolveSecret: async () => "secret", fetch: async () => json({ access_token: "access", expires_in: 7200 }) });
    const client = new QQOpenApiClient({ tokenManager, fetch: async (input, init) => { calls.push({ url: String(input), init }); return String(input).endsWith("/gateway") ? json({ url: "wss://gateway" }) : json({ id: "sent" }); } });
    expect(await client.getGatewayUrl()).toBe("wss://gateway");
    await client.sendC2CText("openid/one", "hello", { msgId: "m1", msgSeq: 2 });
    expect(calls[1]?.url).toContain("openid%2Fone");
    expect(calls[1]?.init?.headers).toEqual(expect.objectContaining({ authorization: "QQBot access" }));
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ msg_type: 0, content: "hello", msg_id: "m1", msg_seq: 2 });
  });

  it("sends C2C inline keyboards and acknowledges interaction callbacks", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const tokenManager = new QQAccessTokenManager({ appId: "app", resolveSecret: async () => "secret", fetch: async () => json({ access_token: "access", expires_in: 7200 }) });
    const client = new QQOpenApiClient({ tokenManager, fetch: async (input, init) => { calls.push({ url: String(input), init }); return json({ id: "sent" }); } });
    await client.sendC2CMenu("openid", "请选择", [[{ text: "主机", callbackData: "m:one" }, { text: "刷新", callbackData: "m:two" }]], { msgId: "m1", msgSeq: 1 });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      msg_type: 2,
      markdown: { content: "请选择" },
      msg_id: "m1",
      msg_seq: 1,
      keyboard: { content: { rows: [{ buttons: [
        { id: "dsh-0-0", render_data: { label: "主机", visited_label: "主机", style: 1 }, action: { type: 1, data: "m:one", permission: { type: 2 }, click_limit: 1 }, group_id: "dsh-menu" },
        { id: "dsh-0-1", render_data: { label: "刷新", visited_label: "刷新", style: 1 }, action: { type: 1, data: "m:two", permission: { type: 2 }, click_limit: 1 }, group_id: "dsh-menu" }
      ] }] } }
    });

    await client.acknowledgeInteraction("interaction/one");
    expect(calls[1]?.url).toContain("/interactions/interaction%2Fone");
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ code: 0 });
  });

  it("invalidates and retries once on 401 without leaking response bodies", async () => {
    let tokenCalls = 0; let apiCalls = 0;
    const tokenManager = new QQAccessTokenManager({ appId: "app", resolveSecret: async () => "secret", fetch: async () => json({ access_token: "access-" + String(++tokenCalls), expires_in: 7200 }) });
    const client = new QQOpenApiClient({ tokenManager, fetch: async () => { apiCalls += 1; return apiCalls === 1 ? json({ message: "private body" }, 401) : json({ url: "wss://gateway" }); } });
    expect(await client.getGatewayUrl()).toBe("wss://gateway");
    expect(tokenCalls).toBe(2); expect(apiCalls).toBe(2);
  });

  it("does not retry a second 401 and omits private bodies from the error", async () => {
    let tokenCalls = 0; let apiCalls = 0;
    const tokenManager = new QQAccessTokenManager({ appId: "app", resolveSecret: async () => "secret", fetch: async () => json({ access_token: "access-" + String(++tokenCalls), expires_in: 7200 }) });
    const client = new QQOpenApiClient({ tokenManager, fetch: async () => { apiCalls += 1; return json({ message: "private body", code: 11244 }, 401); } });
    const failure = client.getGatewayUrl();
    await expect(failure).rejects.toBeInstanceOf(QQApiError);
    await expect(failure).rejects.not.toThrow(/private body/u);
    expect(apiCalls).toBe(2);
    expect(tokenCalls).toBe(2);
  });
});

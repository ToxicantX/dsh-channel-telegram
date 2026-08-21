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

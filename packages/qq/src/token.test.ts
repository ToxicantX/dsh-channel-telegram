import { describe, expect, it } from "vitest";
import { QQAccessTokenManager } from "./token.js";

function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

describe("QQAccessTokenManager", () => {
  it("uses one request for concurrent callers and refreshes 60 seconds early", async () => {
    let now = 1_000; let calls = 0;
    const manager = new QQAccessTokenManager({ appId: "app", resolveSecret: async () => "secret", now: () => now, fetch: async () => { calls += 1; return response({ access_token: "token-" + calls, expires_in: "120" }); } });
    await expect(Promise.all([manager.get(), manager.get(), manager.get()])).resolves.toEqual(["token-1", "token-1", "token-1"]);
    expect(calls).toBe(1);
    now += 59_000; expect(await manager.get()).toBe("token-1");
    now += 2_000; expect(await manager.get()).toBe("token-2");
    expect(calls).toBe(2);
  });

  it("does not join a stale in-flight fetch after invalidation or force refresh", async () => {
    let calls = 0;
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const manager = new QQAccessTokenManager({
      appId: "app",
      resolveSecret: async () => "highly-secret",
      fetch: async () => {
        const n = ++calls;
        if (n === 1) await firstGate;
        return response({ access_token: "token-" + n, expires_in: 7200 });
      }
    });
    const first = manager.get();
    await Promise.resolve();
    manager.invalidate();
    const forced = manager.get(true);
    releaseFirst();
    expect(await first).toBe("token-1");
    expect(await forced).toBe("token-2");
    expect(await manager.get()).toBe("token-2");
    expect(calls).toBe(2);
  });

  it("supports invalidation and never includes the secret in failures", async () => {
    let calls = 0;
    const manager = new QQAccessTokenManager({ appId: "app", resolveSecret: async () => "highly-secret", fetch: async () => { calls += 1; return calls === 1 ? response({ access_token: "one", expires_in: 7200 }) : response({ code: 100016 }, 401); } });
    expect(await manager.get()).toBe("one"); manager.invalidate();
    await expect(manager.get()).rejects.not.toThrow(/highly-secret/u);
  });
});

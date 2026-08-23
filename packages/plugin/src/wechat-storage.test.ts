import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { describe, expect, it } from "vitest";
import { DshWechatStorage, WECHAT_STORAGE_KEY, type WechatCredentialProvider } from "./wechat-storage.js";

class Provider implements WechatCredentialProvider {
  value?: string;
  calls: string[] = [];
  async resolve(_ref: CredentialRef) { return this.value === undefined ? undefined : { value: this.value }; }
  async set(_ref: CredentialRef, value: string) { this.calls.push(value); await Promise.resolve(); this.value = value; }
  async unset(_ref: CredentialRef) { this.value = undefined; }
}

describe("DshWechatStorage", () => {
  it("stores all SDK state in one grant payload under the fixed credential key", async () => {
    const provider = new Provider(); const storage = new DshWechatStorage(provider);
    await Promise.all([
      storage.set("credentials", { token: "secret", accountId: "bot" }),
      storage.set("cursor", "next"),
      storage.set("context_tokens", { user: "context" }),
      storage.set("typing_tickets", { user: "ticket" }),
    ]);
    expect(await storage.get("credentials")).toEqual({ token: "secret", accountId: "bot" });
    expect(await storage.has("cursor")).toBe(true);
    expect(provider.calls).toHaveLength(4);
    expect(JSON.parse(provider.value!)).toEqual({ version: 1, values: {
      credentials: { token: "secret", accountId: "bot" }, cursor: "next",
      context_tokens: { user: "context" }, typing_tickets: { user: "ticket" },
    } });
    expect(WECHAT_STORAGE_KEY).toBe("DSH_CHANNEL_TELEGRAM_WECHAT_ILINK");
    await storage.delete("cursor"); expect(await storage.has("cursor")).toBe(false);
    await storage.clear(); expect(provider.value).toBeUndefined();
  });

  it("rejects malformed records, unsupported keys, and undefined values", async () => {
    const provider = new Provider(); const storage = new DshWechatStorage(provider);
    provider.value = "not-json";
    await expect(storage.get("credentials")).rejects.toThrow(/invalid/u);
    provider.value = JSON.stringify({ version: 1, values: { other: true } });
    await expect(storage.get("credentials")).rejects.toThrow(/Unsupported/u);
    expect(() => storage.set("bad", undefined)).toThrow(/Unsupported/u);
    expect(() => storage.set("credentials", undefined)).toThrow(/JSON-serializable/u);
  });

  it("continues serial mutations after a failed provider write", async () => {
    const provider = new Provider(); let fail = true;
    provider.set = async (_ref, value) => { if (fail) { fail = false; throw new Error("write failed"); } provider.value = value; };
    const storage = new DshWechatStorage(provider);
    await expect(storage.set("cursor", "first")).rejects.toThrow("write failed");
    await storage.set("cursor", "second");
    expect(await storage.get("cursor")).toBe("second");
  });
});

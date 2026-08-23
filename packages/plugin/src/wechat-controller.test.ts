import type { Credentials, IncomingMessage, QrLoginCallbacks, SendContent, Storage } from "@wsxcant/dsh-channel-wechat";
import { describe, expect, it } from "vitest";
import { WechatLoginController, type ManagedWechatBot, type ManagedWechatChannel } from "./wechat-controller.js";

class Memory implements Storage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async set<T>(key: string, value: T) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
  async has(key: string) { return this.values.has(key); }
  async clear() { this.values.clear(); }
}

class Bot implements ManagedWechatBot {
  readonly handlers = new Map<string, ((...args: any[]) => unknown)[]>();
  callbacks?: QrLoginCallbacks;
  credentials?: Credentials;
  startResolve?: () => void;
  stopped = false;
  loginResult?: Promise<Credentials>;
  onMessage(_handler: (message: IncomingMessage) => void | Promise<void>) { return this; }
  async reply(_message: IncomingMessage, _content: SendContent) {}
  async send(_userId: string, _content: SendContent) {}
  async sendTyping(_userId: string) {}
  async stopTyping(_userId: string) {}
  on(event: string, handler: (...args: any[]) => unknown) { const values = this.handlers.get(event) ?? []; values.push(handler); this.handlers.set(event, values); return this; }
  async emit(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) await handler(...args); }
  async login(options?: { force?: boolean; callbacks?: QrLoginCallbacks }) {
    this.callbacks = options?.callbacks;
    this.credentials = this.loginResult === undefined ? credentials() : await this.loginResult;
    await this.emit("login", this.credentials);
    return this.credentials;
  }
  getCredentials() { return this.credentials; }
  start() { return new Promise<void>((resolve) => { this.startResolve = resolve; void this.emit("poll:start"); }); }
  stop() { this.stopped = true; this.startResolve?.(); void this.emit("poll:stop"); }
}

class Channel implements ManagedWechatChannel { attached = 0; disposed = 0; attach() { this.attached += 1; } dispose() { this.disposed += 1; } }
function credentials(): Credentials { return { token: "secret", baseUrl: "https://example.test", accountId: "bot-account", userId: "owner-user", savedAt: new Date(0).toISOString() }; }
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

describe("WechatLoginController", () => {
  it("runs QR login and exposes only public online status", async () => {
    const storage = new Memory(); const bot = new Bot(); const channel = new Channel();
    let finish!: (value: Credentials) => void;
    bot.loginResult = new Promise<Credentials>((resolve) => { finish = resolve; });
    const controller = new WechatLoginController({ storage, botFactory: () => bot, channelFactory: () => channel, qrEncoder: async (url) => "data:image/png;base64," + url });
    controller.beginLogin(); await flush();
    bot.callbacks?.onQrUrl?.("https://qr.example/token"); await flush();
    expect(controller.status()).toEqual({ phase: "qr", qrImage: "data:image/png;base64,https://qr.example/token" });
    bot.callbacks?.onScanned?.(); expect(controller.status()).toEqual({ phase: "scanned" });
    finish(credentials()); await flush();
    expect(controller.status()).toEqual({ phase: "online", accountId: "bot-account", userId: "owner-user" });
    expect(JSON.stringify(controller.status())).not.toContain("secret");
    expect(channel.attached).toBe(1); controller.markInbound(1234); expect(controller.status().lastInboundAt).toBe(1234);
    await controller.dispose(); await controller.dispose();
    expect(channel.disposed).toBe(1); expect(bot.stopped).toBe(true);
  });

  it("bridges a verify-code request without persisting the code", async () => {
    const storage = new Memory(); const bot = new Bot(); let received = "";
    bot.loginResult = new Promise<Credentials>((resolve) => { setImmediate(async () => { received = await bot.callbacks!.onVerifyCode!(false); resolve(credentials()); }); });
    const controller = new WechatLoginController({ storage, botFactory: () => bot, channelFactory: () => new Channel() });
    controller.beginLogin(); await flush();
    expect(controller.status()).toEqual({ phase: "verify-code", verifyRetry: false });
    controller.submitVerifyCode("123456"); await flush();
    expect(received).toBe("123456"); expect([...storage.values.values()]).not.toContain("123456");
    await controller.dispose();
  });

  it("starts from stored credentials and logout removes SDK state", async () => {
    const storage = new Memory(); await storage.set("credentials", credentials()); await storage.set("cursor", "next");
    const bot = new Bot(); const channel = new Channel(); let factoryCalls = 0;
    const controller = new WechatLoginController({ storage, botFactory: () => { factoryCalls += 1; return bot; }, channelFactory: () => channel });
    await controller.startStored();
    expect(controller.status().phase).toBe("online"); expect(factoryCalls).toBe(1);
    await controller.logout();
    expect(storage.values.size).toBe(0); expect(controller.status()).toEqual({ phase: "idle" });
    expect(channel.disposed).toBe(1); expect(bot.stopped).toBe(true);
  });

  it("reports session expiry and redacts runtime failures", async () => {
    const storage = new Memory(); const bot = new Bot(); const errors: unknown[] = [];
    const controller = new WechatLoginController({ storage, botFactory: () => bot, channelFactory: () => new Channel(), onError: (error) => errors.push(error) });
    controller.beginLogin(); await flush(); await bot.emit("session:expired");
    expect(controller.status()).toEqual({ phase: "expired" });
    await bot.emit("error", new Error("token=secret"));
    expect(controller.status()).toEqual({ phase: "error", error: "WeChat runtime failed." }); expect(errors).toHaveLength(1);
    await controller.dispose();
  });

  it("allows an explicit QR relogin after session expiry", async () => {
    const storage = new Memory(); const bots = [new Bot(), new Bot()]; let factoryCalls = 0;
    const controller = new WechatLoginController({
      storage,
      botFactory: () => bots[factoryCalls++]!,
      channelFactory: () => new Channel(),
    });
    controller.beginLogin(); await flush();
    await bots[0]!.emit("session:expired");
    controller.beginLogin(true);
    await flush(); await flush(); await flush();
    expect(bots[0]!.stopped).toBe(true);
    expect(factoryCalls).toBe(2);
    expect(bots[1]!.callbacks).toBeDefined();
    await controller.dispose();
  });
});

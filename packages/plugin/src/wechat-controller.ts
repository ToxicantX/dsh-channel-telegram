import QRCode from "qrcode";
import type { Credentials, QrLoginCallbacks, Storage, WechatBotLike } from "@wsxcant/dsh-channel-wechat";

export type WechatLoginPhase = "idle" | "qr" | "scanned" | "verify-code" | "online" | "expired" | "error";

export interface WechatLoginStatus {
  readonly phase: WechatLoginPhase;
  readonly qrImage?: string;
  readonly verifyRetry?: boolean;
  readonly accountId?: string;
  readonly userId?: string;
  readonly error?: string;
  readonly lastInboundAt?: number;
}

export interface ManagedWechatBot extends WechatBotLike {
  login(options?: { readonly force?: boolean; readonly callbacks?: QrLoginCallbacks }): Promise<Credentials>;
  start(): Promise<void>;
  stop(): void;
  getCredentials(): Credentials | undefined;
  on(event: "session:expired", handler: () => void | Promise<void>): unknown;
  on(event: "session:restored", handler: (credentials: Credentials) => void | Promise<void>): unknown;
  on(event: "poll:start" | "poll:stop" | "close", handler: () => void | Promise<void>): unknown;
  on(event: "error", handler: (error: unknown) => void | Promise<void>): unknown;
}

export interface ManagedWechatChannel {
  attach(): void;
  dispose(): void | Promise<void>;
}

export interface WechatControllerOptions {
  readonly storage: Storage;
  readonly botFactory: (storage: Storage) => ManagedWechatBot;
  readonly channelFactory: (bot: ManagedWechatBot) => ManagedWechatChannel;
  readonly onError?: (error: unknown) => void;
  readonly qrEncoder?: (url: string) => Promise<string>;
}

export class WechatLoginController {
  private statusValue: WechatLoginStatus = { phase: "idle" };
  private bot?: ManagedWechatBot;
  private channel?: ManagedWechatChannel;
  private loginTask?: Promise<void>;
  private runTask?: Promise<void>;
  private readyTask?: Promise<void>;
  private readyResolve?: () => void;
  private verifyWaiter?: { readonly resolve: (code: string) => void; readonly reject: (error: Error) => void };
  private restartTask?: Promise<void>;
  private disposed = false;

  constructor(private readonly options: WechatControllerOptions) {}

  status(): WechatLoginStatus { return { ...this.statusValue }; }
  markInbound(now = Date.now()): void { if (!this.disposed) this.statusValue = { ...this.statusValue, lastInboundAt: now }; }

  async startStored(): Promise<WechatLoginStatus> {
    if (!(await this.options.storage.has("credentials"))) return this.status();
    this.beginLogin(false);
    await this.readyTask?.catch(() => undefined);
    return this.status();
  }

  beginLogin(force = true): WechatLoginStatus {
    if (this.disposed) throw new Error("WeChat login controller is disposed");
    if (this.loginTask !== undefined) {
      if (force && this.statusValue.phase === "expired" && this.restartTask === undefined) {
        this.restartTask = this.restartExpiredLogin().finally(() => { this.restartTask = undefined; });
      }
      return this.status();
    }
    const bot = this.ensureBot();
    this.statusValue = { phase: "idle" };
    this.readyTask = new Promise<void>((resolve) => { this.readyResolve = resolve; });
    this.loginTask = this.loginCore(bot, force).finally(() => { this.loginTask = undefined; });
    return this.status();
  }

  submitVerifyCode(code: string): WechatLoginStatus {
    const value = code.trim();
    if (!/^\d+$/u.test(value) || this.verifyWaiter === undefined) throw new Error("No WeChat verification code is currently required");
    const waiter = this.verifyWaiter;
    this.verifyWaiter = undefined;
    waiter.resolve(value);
    return this.status();
  }

  async logout(): Promise<WechatLoginStatus> {
    await this.stop(true);
    await this.options.storage.clear();
    this.statusValue = { phase: "idle" };
    return this.status();
  }

  async reset(): Promise<WechatLoginStatus> { return this.logout(); }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop(true);
  }

  private ensureBot(): ManagedWechatBot {
    if (this.bot !== undefined) return this.bot;
    const bot = this.options.botFactory(this.options.storage);
    bot.on("session:expired", () => { if (!this.disposed) this.statusValue = { phase: "expired" }; });
    bot.on("session:restored", (credentials) => { if (!this.disposed) this.statusValue = publicCredentials(credentials); });
    bot.on("poll:start", () => {
      const credentials = bot.getCredentials();
      if (!this.disposed) this.statusValue = credentials === undefined ? { phase: "online" } : publicCredentials(credentials);
      this.readyResolve?.();
      this.readyResolve = undefined;
    });
    bot.on("poll:stop", () => { if (!this.disposed && this.statusValue.phase === "online") this.statusValue = { phase: "idle" }; });
    bot.on("error", (error) => {
      this.options.onError?.(error);
      if (!this.disposed) this.statusValue = { phase: "error", error: "WeChat runtime failed." };
    });
    bot.on("close", () => { if (!this.disposed) this.statusValue = { phase: "idle" }; });
    this.bot = bot;
    return bot;
  }

  private async loginCore(bot: ManagedWechatBot, force: boolean): Promise<void> {
    const callbacks: QrLoginCallbacks = {
      onQrUrl: (url) => {
        if (this.disposed) return;
        this.statusValue = { phase: "qr" };
        const encode = this.options.qrEncoder ?? ((value: string) => QRCode.toDataURL(value, { width: 320, margin: 1, errorCorrectionLevel: "M" }));
        void encode(url).then((qrImage) => { if (!this.disposed && this.statusValue.phase === "qr") this.statusValue = { phase: "qr", qrImage }; }, (error) => { this.options.onError?.(error); if (!this.disposed) this.statusValue = { phase: "error", error: "Unable to render WeChat QR code." }; });
      },
      onScanned: () => { if (!this.disposed) this.statusValue = { phase: "scanned" }; },
      onExpired: () => { if (!this.disposed) this.statusValue = { phase: "expired" }; },
      onVerifyCode: (isRetry) => this.waitForVerifyCode(isRetry),
    };
    try {
      const credentials = await bot.login({ force, callbacks });
      if (this.disposed) return;
      this.statusValue = publicCredentials(credentials);
      await this.channel?.dispose();
      this.channel = this.options.channelFactory(bot);
      this.channel.attach();
      try {
        this.runTask = bot.start();
        if (this.statusValue.phase !== "online") this.statusValue = publicCredentials(credentials);
        this.readyResolve?.();
        this.readyResolve = undefined;
        await this.runTask.catch((error) => {
          this.options.onError?.(error);
          if (!this.disposed) this.statusValue = { phase: "error", error: "WeChat polling stopped unexpectedly." };
        });
      } catch (error) {
        this.options.onError?.(error);
        if (!this.disposed) this.statusValue = { phase: "error", error: "WeChat polling stopped unexpectedly." };
      }
    } catch (error) {
      this.options.onError?.(error);
      if (!this.disposed) this.statusValue = { phase: "error", error: "WeChat login failed." };
      this.readyResolve?.();
      this.readyResolve = undefined;
    }
  }

  private waitForVerifyCode(isRetry: boolean): Promise<string> {
    this.verifyWaiter?.reject(new Error("WeChat verification request was replaced"));
    if (!this.disposed) this.statusValue = { phase: "verify-code", verifyRetry: isRetry };
    return new Promise<string>((resolve, reject) => { this.verifyWaiter = { resolve, reject }; });
  }

  private async restartExpiredLogin(): Promise<void> {
    await this.stop(true);
    if (!this.disposed) this.beginLogin(true);
  }

  private async stop(clearBot: boolean): Promise<void> {
    this.verifyWaiter?.reject(new Error("WeChat login stopped"));
    this.verifyWaiter = undefined;
    await this.channel?.dispose();
    this.channel = undefined;
    this.bot?.stop();
    await this.runTask?.catch(() => undefined);
    this.runTask = undefined;
    await this.loginTask?.catch(() => undefined);
    this.loginTask = undefined;
    this.readyResolve?.();
    this.readyResolve = undefined;
    this.readyTask = undefined;
    if (clearBot) this.bot = undefined;
  }
}

function publicCredentials(credentials: Credentials): WechatLoginStatus {
  return { phase: "online", accountId: credentials.accountId, userId: credentials.userId };
}

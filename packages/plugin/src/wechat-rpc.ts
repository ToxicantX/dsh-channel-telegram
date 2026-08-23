import type { Context } from "@deepseek-ai/cordis";
import type { WechatLoginController, WechatLoginStatus } from "./wechat-controller.js";

export const WECHAT_RPC_CHANNEL = "/wechat";
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: "internal"; message: string; details: Record<string, never> } };
interface WechatHostConnection {
  readonly rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>, options: { authority: "trusted-host" | "loopback" }): () => Promise<void> };
}

export function installWechatRpc(ctx: Context, controller: () => WechatLoginController | undefined): () => Promise<void> {
  const connection = (ctx as unknown as { connection: WechatHostConnection }).connection;
  return connection.rpc.handle(WECHAT_RPC_CHANNEL, async (endpoint, payload) => {
    try {
      const value = controller();
      if (value === undefined) return failure("WeChat channel is unavailable");
      switch (endpoint) {
        case "status": assertEmpty(payload); return success(value.status());
        case "begin": assertEmpty(payload); return success(value.beginLogin(true));
        case "verify": return success(value.submitVerifyCode(readCode(payload)));
        case "logout": assertEmpty(payload); return success(await value.logout());
        default: return failure("Unknown WeChat operation");
      }
    } catch (error) { return failure(error instanceof Error ? error.message : "WeChat operation failed"); }
  }, { authority: "trusted-host" });
}

function success(value: WechatLoginStatus): RpcResult<unknown> { return { ok: true, value }; }
function failure(message: string): RpcResult<unknown> { return { ok: false, error: { code: "internal", message, details: {} } }; }
function assertEmpty(value: unknown): void { if (!isRecord(value) || Object.keys(value).length !== 0) throw new Error("Invalid WeChat request"); }
function readCode(value: unknown): string { if (!isRecord(value) || Object.keys(value).join(",") !== "code" || typeof value.code !== "string" || !/^\d{1,16}$/u.test(value.code)) throw new Error("Invalid WeChat verification code"); return value.code; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

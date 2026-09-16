import type { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { installWechatRpc } from "./wechat-rpc.js";

describe("installWechatRpc", () => {
  it("registers after webServer is available using the DSH 0.1.6 connection API", async () => {
    let registered: { channel: string; argumentCount: number } | undefined;
    let disposed = false;
    const ctx = {
      webServer: {},
      connection: {
        rpc: {
          handle(...args: unknown[]) {
            registered = { channel: String(args[0]), argumentCount: args.length };
            return async () => { disposed = true; };
          }
        }
      }
    } as unknown as Context;
    const dispose = installWechatRpc(ctx, () => undefined);
    expect(registered).toEqual({ channel: "/wechat", argumentCount: 2 });
    await dispose();
    expect(disposed).toBe(true);
  });
});

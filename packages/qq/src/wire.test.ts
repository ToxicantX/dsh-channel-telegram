import { describe, expect, it } from "vitest";
import { decodeC2CMessage, decodeGatewayPayload } from "./wire.js";

describe("QQ wire decoders", () => {
  it("decodes C2C OpenID and message index into a stable dedupe key", () => {
    const payload = decodeGatewayPayload(JSON.stringify({ op: 0, s: 7, t: "C2C_MESSAGE_CREATE", id: "event", d: { id: "message", author: { user_openid: "openid" }, content: " hello ", timestamp: "2026-01-01T00:00:00Z", message_scene: { ext: ["auth_token=hidden", "msg_idx=index-1"] } } }))!;
    expect(decodeC2CMessage(payload)).toEqual({ id: "message", userOpenId: "openid", content: "hello", msgIndex: "index-1", dedupeKey: "message:index-1", timestamp: "2026-01-01T00:00:00Z" });
  });
  it("rejects malformed and unsupported dispatches", () => {
    expect(decodeGatewayPayload("not json")).toBeUndefined();
    expect(decodeGatewayPayload({ op: "0" })).toBeUndefined();
    expect(decodeC2CMessage({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: {} })).toBeUndefined();
    expect(decodeC2CMessage({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m", author: {}, content: "x" } })).toBeUndefined();
  });
});

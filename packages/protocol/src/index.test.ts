import { describe, expect, it } from "vitest";
import { makeEnvelope, parseEnvelope, ProtocolValidationError, PROTOCOL_VERSION } from "./index.js";

describe("protocol envelope", () => {
  it("accepts a versioned heartbeat", () => {
    const value = makeEnvelope("message-1", { kind: "heartbeat", sequence: 1, sentAt: 10 }, "request-1", 10);
    expect(value.version).toBe(PROTOCOL_VERSION);
    expect(parseEnvelope(value).message.kind).toBe("heartbeat");
  });

  it("rejects an unsupported version", () => {
    expect(() => parseEnvelope({ version: 2, messageId: "m", timestamp: 1, message: { kind: "heartbeat" } }))
      .toThrowError(ProtocolValidationError);
  });

  it("rejects missing identity and unknown kinds", () => {
    expect(() => parseEnvelope({ version: 1, messageId: "", timestamp: 1, message: { kind: "wat" } }))
      .toThrow(/messageId/);
    expect(() => parseEnvelope({ version: 1, messageId: "m", timestamp: 1, message: { kind: "wat" } }))
      .toThrow(/Unknown/);
  });
});

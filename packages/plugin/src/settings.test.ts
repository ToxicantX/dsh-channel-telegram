import { describe, expect, it } from "vitest";
import { normalizeQQSettings, normalizeTelegramSettings, runtimeHostName } from "./index.js";

describe("normalizeTelegramSettings", () => {
  it("trims the host name and deduplicates allowed users", () => {
    expect(normalizeTelegramSettings({ hostName: "  Workstation  ", allowedUserIds: [42, 42, 7] })).toEqual({
      hostName: "Workstation",
      allowedUserIds: [42, 7]
    });
  });

  it.each(["", "   ", "x".repeat(65)])("rejects invalid host name %j", (hostName) => {
    expect(() => normalizeTelegramSettings({ hostName, allowedUserIds: [] })).toThrow(/host name/);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid user ID %s", (id) => {
    expect(() => normalizeTelegramSettings({ hostName: "Local DSH", allowedUserIds: [id] })).toThrow(/user IDs/);
  });
});

describe("normalizeQQSettings", () => {
  it("trims and deduplicates QQ OpenIDs", () => {
    expect(normalizeQQSettings({ appId: " 123 ", allowedOpenIds: [" A ", "A", "B"], progressIntervalMs: 3000, openIdLookupEnabled: true })).toEqual({ appId: "123", allowedOpenIds: ["A", "B"], progressIntervalMs: 3000, openIdLookupEnabled: true });
  });
  it("rejects oversized AppIDs and OpenIDs", () => {
    expect(() => normalizeQQSettings({ appId: "x".repeat(65), allowedOpenIds: [], progressIntervalMs: 3000, openIdLookupEnabled: false })).toThrow(/AppID/);
    expect(() => normalizeQQSettings({ appId: "123", allowedOpenIds: ["x".repeat(129)], progressIntervalMs: 3000, openIdLookupEnabled: false })).toThrow(/OpenIDs/);
  });

  it.each([999, 60001, 1.5])("rejects invalid progress interval %s", (progressIntervalMs) => {
    expect(() => normalizeQQSettings({ appId: "123", allowedOpenIds: [], progressIntervalMs, openIdLookupEnabled: false })).toThrow(/interval/);
  });
});

describe("runtimeHostName", () => {
  it("falls back when Telegram host settings are unavailable to QQ", () => {
    expect(runtimeHostName("  QQ host  ")).toBe("QQ host");
    expect(runtimeHostName(" ")).toBe("Local DSH");
    expect(runtimeHostName("x".repeat(65))).toBe("Local DSH");
  });
});

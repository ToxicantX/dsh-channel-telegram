import { describe, expect, it } from "vitest";
import { normalizeTelegramSettings } from "./index.js";

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

import { describe, expect, it } from "vitest";
import { parseTelegramSettingsDraft } from "./validation.js";

describe("parseTelegramSettingsDraft", () => {
  it("trims the host and accepts comma or whitespace-separated unique IDs", () => {
    expect(parseTelegramSettingsDraft("  Workstation  ", "42, 7\n42").value).toEqual({ hostName: "Workstation", allowedUserIds: [42, 7] });
  });

  it.each([
    ["", "1", "Host name is required"],
    ["x".repeat(65), "1", "Host name must be 64 characters or fewer"],
    ["Host", "", "Add at least one Telegram user ID"],
    ["Host", "1.5", "User IDs must contain digits only"],
    ["Host", "0", "User IDs must be positive safe integers"],
    ["Host", String(Number.MAX_SAFE_INTEGER + 1), "User IDs must be positive safe integers"]
  ])("rejects invalid draft", (hostName, ids, message) => {
    const result = parseTelegramSettingsDraft(hostName, ids);
    expect([result.hostNameError, result.userIdsError]).toContain(message);
    expect(result.value).toBeUndefined();
  });
});

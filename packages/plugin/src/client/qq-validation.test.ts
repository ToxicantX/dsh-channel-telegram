import { describe, expect, it } from "vitest";
import { canRemoveQQSecret, canSaveQQDraft, createQQDraft, discardQQDraft, isQQDraftDirty, parseQQSettingsDraft } from "./qq-validation.js";

describe("parseQQSettingsDraft", () => {
  it("trims AppID and deduplicates comma or whitespace OpenIDs", () => { expect(parseQQSettingsDraft(" 123 ", "A, B\nA", "3000", true).value).toEqual({ appId: "123", allowedOpenIds: ["A", "B"], progressIntervalMs: 3000, openIdLookupEnabled: true }); });
  it.each([["", "A", "3000", "AppID is required"],["1", "", "3000", "Add at least one QQ user OpenID"],["1", "A", "999", "Progress interval must be an integer from 1000 to 60000 ms"],["1", "A", "1.5", "Progress interval must be an integer from 1000 to 60000 ms"]])("rejects invalid QQ drafts", (appId, ids, interval, message) => { const result = parseQQSettingsDraft(appId, ids, interval, false); expect([result.appIdError, result.openIdsError, result.intervalError]).toContain(message); expect(result.value).toBeUndefined(); });

  it("tracks revision, dirty, discard, save, and secret removal state", () => {
    const snapshot = { value: { appId: "app", allowedOpenIds: ["A", "B"], progressIntervalMs: 3000, openIdLookupEnabled: false }, revision: 4 };
    const clean = createQQDraft(snapshot);
    expect(isQQDraftDirty(snapshot, clean)).toBe(false);
    expect(isQQDraftDirty(snapshot, { ...clean, revision: 5 })).toBe(true);
    expect(isQQDraftDirty(snapshot, { ...clean, secret: "  " })).toBe(false);
    expect(isQQDraftDirty(snapshot, { ...clean, openIdLookupEnabled: true })).toBe(true);
    const changed = { ...clean, appId: "next", secret: "secret" };
    expect(canSaveQQDraft(snapshot, changed, true, true, false)).toBe(true);
    expect(canSaveQQDraft(snapshot, changed, true, false, false)).toBe(false);
    expect(canSaveQQDraft(snapshot, { ...changed, appId: "" }, true, true, false)).toBe(false);
    expect(canSaveQQDraft(snapshot, changed, true, true, true)).toBe(false);
    expect(canRemoveQQSecret(true, true, false)).toBe(true);
    expect(canRemoveQQSecret(false, true, false)).toBe(false);
    expect(canRemoveQQSecret(true, false, false)).toBe(false);
    expect(canRemoveQQSecret(true, true, true)).toBe(false);
    expect(discardQQDraft(snapshot)).toEqual(clean);
  });
});

export interface QQSettingsDraft { readonly appId: string; readonly allowedOpenIds: string[]; readonly progressIntervalMs: number; readonly openIdLookupEnabled: boolean; }
export interface QQDraftValidation { readonly value?: QQSettingsDraft; readonly appIdError?: string; readonly openIdsError?: string; readonly intervalError?: string; }

export interface QQDraftState {
  readonly appId: string;
  readonly openIds: string;
  readonly interval: string;
  readonly secret: string;
  readonly openIdLookupEnabled: boolean;
  readonly revision: number | undefined;
}

export interface QQDraftSnapshot {
  readonly value: QQSettingsDraft;
  readonly revision: number | undefined;
}

export function createQQDraft(snapshot: QQDraftSnapshot): QQDraftState {
  return {
    appId: snapshot.value.appId,
    openIds: snapshot.value.allowedOpenIds.join("\n"),
    interval: String(snapshot.value.progressIntervalMs),
    secret: "",
    openIdLookupEnabled: snapshot.value.openIdLookupEnabled,
    revision: snapshot.revision
  };
}

export function isQQDraftDirty(snapshot: QQDraftSnapshot, draft: QQDraftState): boolean {
  return snapshot.revision !== draft.revision
    || draft.appId !== snapshot.value.appId
    || draft.openIds !== snapshot.value.allowedOpenIds.join("\n")
    || draft.interval !== String(snapshot.value.progressIntervalMs)
    || draft.openIdLookupEnabled !== snapshot.value.openIdLookupEnabled
    || draft.secret.trim() !== "";
}

export function discardQQDraft(snapshot: QQDraftSnapshot): QQDraftState {
  return createQQDraft(snapshot);
}

export function canSaveQQDraft(snapshot: QQDraftSnapshot, draft: QQDraftState, scopeReady: boolean, credentialWritable: boolean, busy: boolean): boolean {
  const validation = parseQQSettingsDraft(draft.appId, draft.openIds, draft.interval, draft.openIdLookupEnabled);
  return !busy && scopeReady && validation.value !== undefined && isQQDraftDirty(snapshot, draft) && (draft.secret.trim() === "" || credentialWritable);
}

export function canRemoveQQSecret(configured: boolean, writable: boolean, busy: boolean): boolean {
  return configured && writable && !busy;
}

export function parseQQSettingsDraft(appIdInput: string, openIdsInput: string, intervalInput: string, openIdLookupEnabled: boolean): QQDraftValidation {
  const appId = appIdInput.trim();
  const appIdError = appId === "" ? "AppID is required" : appId.length > 64 ? "AppID must be 64 characters or fewer" : undefined;
  const values = openIdsInput.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean);
  const allowedOpenIds = [...new Set(values)];
  const openIdsError = allowedOpenIds.length === 0 ? "Add at least one QQ user OpenID" : allowedOpenIds.some((value) => value.length > 128) ? "OpenIDs must be 128 characters or fewer" : undefined;
  const progressIntervalMs = Number(intervalInput);
  const intervalError = !Number.isSafeInteger(progressIntervalMs) || progressIntervalMs < 1000 || progressIntervalMs > 60000 ? "Progress interval must be an integer from 1000 to 60000 ms" : undefined;
  if (appIdError !== undefined || openIdsError !== undefined || intervalError !== undefined) return { appIdError, openIdsError, intervalError };
  return { value: { appId, allowedOpenIds, progressIntervalMs, openIdLookupEnabled } };
}

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { ClientContext, SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import { parseTelegramSettingsDraft } from "./validation.js";

const SETTINGS_NAMESPACE = "telegram";
const TOKEN_REF = "TELEGRAM_BOT_TOKEN";

interface TelegramSettings { readonly hostName: string; readonly allowedUserIds: number[]; }
type ApiClient = ConnectionHandle["api"];
interface TelegramCardProps { readonly api: ApiClient; readonly scope: SettingsScope<TelegramSettings>; }
interface CredentialState { readonly configured: boolean; readonly source?: string; readonly writable: boolean; }
const EMPTY_CREDENTIAL: CredentialState = { configured: false, writable: true };

function TelegramSettingsCard({ api, scope }: TelegramCardProps): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope), scope.getSnapshot.bind(scope));
  const [hostName, setHostName] = useState("");
  const [userIds, setUserIds] = useState("");
  const [token, setToken] = useState("");
  const [credential, setCredential] = useState<CredentialState>(EMPTY_CREDENTIAL);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [draftRevision, setDraftRevision] = useState(snapshot.revision);

  useEffect(() => {
    if (snapshot.value === undefined) return;
    setHostName(snapshot.value.hostName);
    setUserIds(snapshot.value.allowedUserIds.join("\n"));
    setDraftRevision(snapshot.revision);
  }, [snapshot.revision, snapshot.value]);

  const readCredential = useCallback(async (): Promise<void> => {
    const response = await api.credentials.describe({ refs: [TOKEN_REF] });
    if (!response.result.ok) throw new Error("Unable to read credential status");
    setCredential(response.result.value.credentials[TOKEN_REF] ?? EMPTY_CREDENTIAL);
  }, [api]);

  useEffect(() => { void readCredential().catch(() => { setFailed(true); setMessage("Credential status unavailable"); }); }, [readCredential]);

  if (snapshot.value === undefined) return null;
  const validation = parseTelegramSettingsDraft(hostName, userIds);
  const dirty = snapshot.revision !== draftRevision || hostName !== snapshot.value.hostName || userIds !== snapshot.value.allowedUserIds.join("\n") || token.trim().length > 0;
  const canWrite = snapshot.status === "ready" && snapshot.writable && !busy;
  const saveDisabled = !dirty || validation.value === undefined || !canWrite || (token.length > 0 && !credential.writable);

  const discard = (): void => {
    setHostName(snapshot.value!.hostName);
    setUserIds(snapshot.value!.allowedUserIds.join("\n"));
    setToken("");
    setMessage(undefined);
    setFailed(false);
    setDraftRevision(snapshot.revision);
  };

  const save = async (): Promise<void> => {
    if (saveDisabled || validation.value === undefined) return;
    setBusy(true); setFailed(false); setMessage(undefined);
    try {
      await scope.set("hostName", validation.value.hostName);
      await scope.set("allowedUserIds", validation.value.allowedUserIds);
      if (token.trim().length > 0) {
        const response = await api.credentials.set({ ref: TOKEN_REF, value: token.trim() });
        if (!response.result.ok) throw new Error("Bot Token was not accepted");
      }
      setToken(""); await readCredential(); setMessage("Saved");
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Save failed"); }
    finally { setBusy(false); }
  };

  const removeToken = async (): Promise<void> => {
    if (!credential.writable || busy) return;
    setBusy(true); setFailed(false); setMessage(undefined);
    try {
      const response = await api.credentials.unset({ ref: TOKEN_REF });
      if (!response.result.ok) throw new Error("Bot Token could not be removed");
      setToken(""); await readCredential(); setMessage("Bot Token removed");
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : "Remove failed"); }
    finally { setBusy(false); }
  };

  const credentialLabel = credential.configured ? "Bot Token configured" + (credential.source ? " via " + credential.source : "") : "Bot Token not configured";
  const titleId = "dct-title-telegram";
  return <li className={open ? "dct-card dct-open" : "dct-card"}>
    <button type="button" className="dct-header" aria-expanded={open} aria-controls="dct-body-telegram" aria-label={(open ? "Collapse" : "Expand") + " settings: Telegram"} onClick={() => setOpen((value) => !value)}>
      <span className="dct-header-copy"><strong id={titleId}>Telegram</strong><span className={credential.configured ? "dct-status dct-ready" : "dct-status"}>{credentialLabel}</span></span>
      {dirty && <span className="dct-unsaved">Unsaved</span>}
      <span className={open ? "dct-chevron dct-chevron-open" : "dct-chevron"} aria-hidden="true" />
    </button>
    {open && <div id="dct-body-telegram" className="dct-body" role="region" aria-labelledby={titleId}>
      <label className="dct-field"><span>Current host name</span><input value={hostName} maxLength={64} disabled={!canWrite} onChange={(event) => setHostName(event.currentTarget.value)} aria-invalid={validation.hostNameError !== undefined} />{validation.hostNameError && <small className="dct-error">{validation.hostNameError}</small>}</label>
      <label className="dct-field"><span>Allowed Telegram user IDs</span><textarea value={userIds} rows={3} inputMode="numeric" disabled={!canWrite} onChange={(event) => setUserIds(event.currentTarget.value)} aria-invalid={validation.userIdsError !== undefined} />{validation.userIdsError && <small className="dct-error">{validation.userIdsError}</small>}</label>
      <label className="dct-field"><span>Bot Token</span><input type="password" value={token} autoComplete="new-password" disabled={!credential.writable || busy} onChange={(event) => setToken(event.currentTarget.value)} placeholder={credential.configured ? "Replace configured token" : "Enter Bot Token"} /></label>
      <footer className="dct-actions"><span className="dct-action-message">{message && <span role={failed ? "alert" : "status"} className={failed ? "dct-message dct-error" : "dct-message"}>{message}</span>}</span><button type="button" className="dct-secondary" disabled={!dirty || busy} onClick={discard}>Discard</button>{credential.configured && <button type="button" className="dct-secondary" disabled={!credential.writable || busy} onClick={() => void removeToken()}>Remove Token</button>}<button type="button" className="dct-primary" disabled={saveDisabled} onClick={() => void save()}>{busy ? "Saving..." : "Save"}</button></footer>
    </div>}
  </li>;
}

const CSS = [
  ".dct-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;min-width:0;transition:border-color .16s,background .16s}.dct-card:hover{border-color:var(--dsw-alias-label-dimmed)}.dct-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".dct-header{appearance:none;width:100%;box-sizing:border-box;padding:14px 16px;display:flex;align-items:center;gap:12px;border:0;border-radius:12px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.dct-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.dct-header-copy{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;flex:1}.dct-header strong{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.dct-status{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;overflow-wrap:anywhere}.dct-ready{color:var(--dsw-alias-label-tertiary)}.dct-unsaved{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.dct-chevron{width:7px;height:7px;border-right:2px solid var(--dsw-alias-label-tertiary);border-bottom:2px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg);transition:transform .16s;flex:none}.dct-chevron-open{transform:rotate(225deg)}",
  ".dct-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}.dct-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}.dct-field+.dct-field{border-top:1px solid var(--dsw-alias-border-l2)}.dct-field input,.dct-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font:inherit;font-weight:400;line-height:18px;resize:vertical}.dct-field input{height:36px}.dct-field input:focus-visible,.dct-field textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}.dct-field [aria-invalid=true]{border-color:var(--dsw-alias-label-error)}",
  ".dct-error{color:var(--dsw-alias-label-error);font-size:12px;font-weight:400}.dct-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}.dct-action-message{margin-right:auto;min-width:0}.dct-actions button{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}.dct-actions button:disabled{opacity:.4;cursor:default}.dct-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.dct-secondary{border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}.dct-secondary:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.dct-primary:focus-visible,.dct-secondary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.dct-message{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}@media(max-width:520px){.dct-actions{align-items:stretch}.dct-action-message{width:100%;margin-right:0}.dct-actions button{flex:1 1 auto}}"
].join("");

export const inject = ["slots", "connection", "remote", "settingsScope"];

export function apply(ctx: ClientContext): void {
  const { api } = ctx.get("connection");
  const scope = ctx.settingsScope.bind<TelegramSettings>({ namespace: SETTINGS_NAMESPACE });
  ctx.effect(() => { const tag = document.createElement("style"); tag.dataset.plugin = "dsh-channel-telegram"; tag.textContent = CSS; document.head.appendChild(tag); return () => tag.remove(); }, "telegram settings styles");
  ctx.effect(function* () { yield ctx.slots.register({ name: "settings.plugin.item", key: SETTINGS_NAMESPACE, inject: () => ({ api, scope }) }, TelegramSettingsCard); });
}

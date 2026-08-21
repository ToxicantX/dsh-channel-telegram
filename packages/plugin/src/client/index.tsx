import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { ClientContext, SettingsScope } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import { parseTelegramSettingsDraft } from "./validation.js";

const SETTINGS_NAMESPACE = "telegram";
const TOKEN_REF = "TELEGRAM_BOT_TOKEN";

interface TelegramSettings {
  readonly hostName: string;
  readonly allowedUserIds: number[];
}

type ApiClient = ConnectionHandle["api"];

interface TelegramCardProps {
  readonly api: ApiClient;
  readonly scope: SettingsScope<TelegramSettings>;
}

interface CredentialState {
  readonly configured: boolean;
  readonly source?: string;
  readonly writable: boolean;
}

const EMPTY_CREDENTIAL: CredentialState = { configured: false, writable: true };

function TelegramSettingsCard({ api, scope }: TelegramCardProps): React.JSX.Element {
  const snapshot = useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope), scope.getSnapshot.bind(scope));
  const [hostName, setHostName] = useState("");
  const [userIds, setUserIds] = useState("");
  const [token, setToken] = useState("");
  const [credential, setCredential] = useState<CredentialState>(EMPTY_CREDENTIAL);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (snapshot.value === undefined) return;
    setHostName(snapshot.value.hostName);
    setUserIds(snapshot.value.allowedUserIds.join("\n"));
  }, [snapshot.revision, snapshot.value]);

  const readCredential = useCallback(async (): Promise<void> => {
    const response = await api.credentials.describe({ refs: [TOKEN_REF] });
    if (!response.result.ok) throw new Error("Unable to read credential status");
    const view = response.result.value.credentials[TOKEN_REF];
    setCredential(view ?? EMPTY_CREDENTIAL);
  }, [api]);

  useEffect(() => {
    void readCredential().catch(() => {
      setFailed(true);
      setMessage("Credential status unavailable");
    });
  }, [readCredential]);

  const validation = parseTelegramSettingsDraft(hostName, userIds);
  const canWrite = snapshot.status === "ready" && snapshot.writable && !busy;

  const save = async (): Promise<void> => {
    if (validation.value === undefined || !canWrite) return;
    setBusy(true);
    setFailed(false);
    setMessage(undefined);
    try {
      await scope.set("hostName", validation.value.hostName);
      await scope.set("allowedUserIds", validation.value.allowedUserIds);
      if (token.trim().length > 0) {
        const response = await api.credentials.set({ ref: TOKEN_REF, value: token.trim() });
        if (!response.result.ok) throw new Error("Bot Token was not accepted");
      }
      setToken("");
      await readCredential();
      setMessage("Saved");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const removeToken = async (): Promise<void> => {
    if (!credential.writable || busy) return;
    setBusy(true);
    setFailed(false);
    setMessage(undefined);
    try {
      const response = await api.credentials.unset({ ref: TOKEN_REF });
      if (!response.result.ok) throw new Error("Bot Token could not be removed");
      setToken("");
      await readCredential();
      setMessage("Bot Token removed");
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  const credentialLabel = credential.configured
    ? "Bot Token configured" + (credential.source ? " via " + credential.source : "")
    : "Bot Token not configured";

  return <section className="dct-card" aria-labelledby="dct-title">
    <header className="dct-header">
      <div>
        <h3 id="dct-title">Telegram</h3>
        <span className={credential.configured ? "dct-status dct-ready" : "dct-status"}>{credentialLabel}</span>
      </div>
    </header>

    <label className="dct-field">
      <span>Current host name</span>
      <input value={hostName} maxLength={64} disabled={!canWrite} onChange={(event) => setHostName(event.currentTarget.value)} aria-invalid={validation.hostNameError !== undefined} />
      {validation.hostNameError && <small className="dct-error">{validation.hostNameError}</small>}
    </label>

    <label className="dct-field">
      <span>Allowed Telegram user IDs</span>
      <textarea value={userIds} rows={3} inputMode="numeric" disabled={!canWrite} onChange={(event) => setUserIds(event.currentTarget.value)} aria-invalid={validation.userIdsError !== undefined} />
      {validation.userIdsError && <small className="dct-error">{validation.userIdsError}</small>}
    </label>

    <label className="dct-field">
      <span>Bot Token</span>
      <input type="password" value={token} autoComplete="new-password" disabled={!credential.writable || busy} onChange={(event) => setToken(event.currentTarget.value)} placeholder={credential.configured ? "Replace configured token" : "Enter Bot Token"} />
    </label>

    <div className="dct-actions">
      <button type="button" className="dct-primary" disabled={!canWrite || validation.value === undefined || (token.length > 0 && !credential.writable)} onClick={() => void save()}>{busy ? "Saving..." : "Save"}</button>
      {credential.configured && <button type="button" className="dct-secondary" disabled={!credential.writable || busy} onClick={() => void removeToken()}>Remove Token</button>}
      {message && <span role={failed ? "alert" : "status"} className={failed ? "dct-message dct-error" : "dct-message"}>{message}</span>}
    </div>
  </section>;
}

const CSS = [
  ".dct-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:0;min-width:0}",
  ".dct-header{display:flex;align-items:flex-start;justify-content:space-between;padding-bottom:12px}.dct-header h3{font-size:14px;line-height:20px;margin:0 0 4px;color:var(--dsw-alias-label-primary);letter-spacing:0}.dct-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.dct-ready{color:var(--dsw-alias-label-success,var(--dsw-alias-label-secondary))}",
  ".dct-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2);font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
  ".dct-field input,.dct-field textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font:inherit;font-weight:400;line-height:18px;resize:vertical}.dct-field input{height:36px}.dct-field input:focus-visible,.dct-field textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}.dct-field [aria-invalid=true]{border-color:var(--dsw-alias-label-error)}",
  ".dct-error{color:var(--dsw-alias-label-error);font-size:12px;font-weight:400}.dct-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}.dct-actions button{height:34px;border-radius:8px;padding:0 13px;font:inherit;font-size:13px;cursor:pointer}.dct-actions button:disabled{opacity:.5;cursor:default}.dct-primary{border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:white}.dct-secondary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}.dct-message{font-size:12px;color:var(--dsw-alias-label-secondary);margin-left:auto}@media(max-width:520px){.dct-card{padding:12px}.dct-message{width:100%;margin-left:0}}"
].join("");

export const inject = ["slots", "connection", "remote", "settingsScope"];

export function apply(ctx: ClientContext): void {
  const { api } = ctx.get("connection");
  const scope = ctx.settingsScope.bind<TelegramSettings>({ namespace: SETTINGS_NAMESPACE });
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-channel-telegram";
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return () => tag.remove();
  }, "telegram settings styles");
  ctx.effect(function* () {
    yield ctx.slots.register({
      name: "settings.plugin.item",
      key: SETTINGS_NAMESPACE,
      inject: () => ({ api, scope })
    }, TelegramSettingsCard);
  });
}

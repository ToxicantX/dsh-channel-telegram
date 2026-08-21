import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { QQAccessTokenManager, QQC2CChannel, QQGatewayConnection, QQOpenApiClient } from "@wsxcant/dsh-channel-qq";
import { DshControlPlane, TelegramGateway, createTelegramBot, registerTelegramCommands, sendTelegramDiagnosticReady } from "@wsxcant/dsh-channel-telegram-gateway";
import { DshAdapter } from "./dsh-adapter.js";

export const name = "dsh-channel-telegram";
export const inject = [
  "agentDefaultModel", "agentPresets", "agents", "credentials",
  "sessionQuery", "sessions", "workspaceRegistry"
];

export const TELEGRAM_BOT_TOKEN_REF = "TELEGRAM_BOT_TOKEN";
export const QQ_BOT_APP_SECRET_REF = "QQ_BOT_APP_SECRET";
export const TELEGRAM_SETTINGS_NAMESPACE = settingsNamespace("telegram");
export const QQ_SETTINGS_NAMESPACE = settingsNamespace("qq");
export const DEFAULT_HOST_NAME = "Local DSH";

export interface Config {
  readonly allowedUserIds: number[];
  readonly hostName: string;
  readonly turnTimeoutMs: number;
  readonly progressEditIntervalMs: number;
  readonly diagnosticLogging: boolean;
  readonly qqAppId: string;
  readonly qqAllowedOpenIds: string[];
  readonly qqProgressIntervalMs: number;
  readonly qqOpenIdLookupEnabled: boolean;
}

export const Config: z<Config> = z.object({
  allowedUserIds: z.array(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)).default([]),
  hostName: z.string().min(1).max(64).default(DEFAULT_HOST_NAME),
  turnTimeoutMs: z.number().step(1).min(1).default(600000),
  progressEditIntervalMs: z.number().step(1).min(1).default(1000),
  diagnosticLogging: z.boolean().default(false),
  qqAppId: z.string().max(64).default(""),
  qqAllowedOpenIds: z.array(z.string().min(1).max(128)).default([]),
  qqProgressIntervalMs: z.number().step(1).min(1000).max(60000).default(3000),
  qqOpenIdLookupEnabled: z.boolean().default(false)
});

export interface TelegramRuntimeSettings { readonly allowedUserIds: number[]; readonly hostName: string; }
export interface QQRuntimeSettings { readonly appId: string; readonly allowedOpenIds: string[]; readonly progressIntervalMs: number; readonly openIdLookupEnabled: boolean; }

export const TelegramSettingsSchema: z<TelegramRuntimeSettings> = z.object({
  allowedUserIds: z.array(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)).default([]),
  hostName: z.string().min(1).max(64).default(DEFAULT_HOST_NAME)
});
export const QQSettingsSchema: z<QQRuntimeSettings> = z.object({
  appId: z.string().max(64).default(""),
  allowedOpenIds: z.array(z.string().min(1).max(128)).default([]),
  progressIntervalMs: z.number().step(1).min(1000).max(60000).default(3000),
  openIdLookupEnabled: z.boolean().default(false)
});

export function normalizeTelegramSettings(config: TelegramRuntimeSettings): TelegramRuntimeSettings {
  const hostName = config.hostName.trim();
  if (hostName.length === 0 || hostName.length > 64) throw new Error("Telegram host name must contain 1 to 64 characters");
  const allowedUserIds = [...new Set(config.allowedUserIds)];
  if (allowedUserIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("Telegram allowed user IDs must be positive safe integers");
  return { allowedUserIds, hostName };
}
export function runtimeHostName(value: string): string {
  const hostName = value.trim();
  return hostName.length >= 1 && hostName.length <= 64 ? hostName : DEFAULT_HOST_NAME;
}

export function normalizeQQSettings(config: QQRuntimeSettings): QQRuntimeSettings {
  const appId = config.appId.trim();
  if (appId.length > 64) throw new Error("QQ AppID must not exceed 64 characters");
  const allowedOpenIds = [...new Set(config.allowedOpenIds.map((value) => value.trim()).filter(Boolean))];
  if (allowedOpenIds.some((value) => value.length > 128)) throw new Error("QQ OpenIDs must not exceed 128 characters");
  const progressIntervalMs = config.progressIntervalMs;
  if (!Number.isSafeInteger(progressIntervalMs) || progressIntervalMs < 1000 || progressIntervalMs > 60_000) {
    throw new Error("QQ progress interval must be an integer from 1000 to 60000 ms");
  }
  return { appId, allowedOpenIds, progressIntervalMs, openIdLookupEnabled: config.openIdLookupEnabled };
}

type TelegramBot = ReturnType<typeof createTelegramBot>;
interface TelegramRuntime { readonly adapter: DshAdapter; readonly gateway: TelegramGateway; readonly bot: TelegramBot; running: Promise<void>; stopping: boolean; }
interface QQRuntime { readonly adapter: DshAdapter; readonly control: DshControlPlane; readonly channel: QQC2CChannel; readonly abort: AbortController; running: Promise<void>; stopping: boolean; }

async function stopTelegram(runtime: TelegramRuntime | undefined): Promise<void> {
  if (runtime === undefined) return; runtime.stopping = true; runtime.gateway.dispose();
  try { await runtime.bot.stop(); } finally { await runtime.running.catch(() => undefined); await runtime.adapter.dispose(); }
}
async function stopQQ(runtime: QQRuntime | undefined): Promise<void> {
  if (runtime === undefined) return; runtime.stopping = true; runtime.abort.abort(); runtime.channel.dispose(); runtime.control.dispose();
  await runtime.running.catch(() => undefined); await runtime.adapter.dispose();
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger(name);
  let telegramSource = (): TelegramRuntimeSettings => ({ allowedUserIds: config.allowedUserIds, hostName: config.hostName });
  let qqSource = (): QQRuntimeSettings => ({ appId: config.qqAppId, allowedOpenIds: config.qqAllowedOpenIds, progressIntervalMs: config.qqProgressIntervalMs, openIdLookupEnabled: config.qqOpenIdLookupEnabled });
  let active = false; let telegramRuntime: TelegramRuntime | undefined; let qqRuntime: QQRuntime | undefined;
  let telegramQueue = Promise.resolve(); let qqQueue = Promise.resolve();

  const reconcileTelegram = async (): Promise<void> => {
    await stopTelegram(telegramRuntime); telegramRuntime = undefined; if (!active) return;
    const settings = normalizeTelegramSettings(telegramSource());
    const resolved = await ctx.credentials.resolve(credentialRef(TELEGRAM_BOT_TOKEN_REF));
    if (!active) return;
    if (resolved === undefined || settings.allowedUserIds.length === 0) { logger.info("Telegram poller is disabled until a Bot Token and allowed user ID are configured"); return; }
    const adapter = new DshAdapter(ctx, { turnTimeoutMs: config.turnTimeoutMs, hostName: settings.hostName });
    const gateway = new TelegramGateway(adapter, { allowedUserIds: settings.allowedUserIds });
    const bot = createTelegramBot(resolved.value, gateway, { progressEditIntervalMs: config.progressEditIntervalMs, ...(config.diagnosticLogging ? { onInbound: (metadata: unknown) => { logger.info("Telegram inbound", metadata); } } : {}) });
    try { await registerTelegramCommands(bot); } catch (error) { logger.warn("Failed to register Telegram commands", error); }
    if (!active) { gateway.dispose(); await adapter.dispose(); return; }
    if (config.diagnosticLogging) { try { await sendTelegramDiagnosticReady(bot, settings.allowedUserIds); } catch (error) { logger.warn("Failed to send Telegram diagnostic readiness notice", error); } }
    if (!active) { gateway.dispose(); await adapter.dispose(); return; }
    const next: TelegramRuntime = { adapter, gateway, bot, running: Promise.resolve(), stopping: false };
    next.running = bot.start({ drop_pending_updates: false }); void next.running.catch((error) => { if (!next.stopping) logger.error(error); }); telegramRuntime = next;
  };

  const reconcileQQ = async (): Promise<void> => {
    await stopQQ(qqRuntime); qqRuntime = undefined; if (!active) return;
    const settings = normalizeQQSettings(qqSource());
    const resolved = await ctx.credentials.resolve(credentialRef(QQ_BOT_APP_SECRET_REF));
    if (!active) return;
    if (resolved === undefined || settings.appId === "" || settings.allowedOpenIds.length === 0) { logger.info("QQ Gateway is disabled until AppID, AppSecret, and allowed OpenIDs are configured"); return; }
    const hostName = runtimeHostName(telegramSource().hostName);
    const adapter = new DshAdapter(ctx, { turnTimeoutMs: config.turnTimeoutMs, hostName });
    const control = new DshControlPlane(adapter, {});
    const tokenManager = new QQAccessTokenManager({ appId: settings.appId, resolveSecret: async () => resolved.value });
    const api = new QQOpenApiClient({ tokenManager });
    const connection = new QQGatewayConnection({ api, tokenManager });
    if (!active) { control.dispose(); await adapter.dispose(); return; }
    const channel = new QQC2CChannel({ control, api, allowedOpenIds: settings.allowedOpenIds, progressIntervalMs: settings.progressIntervalMs, identityLookupEnabled: settings.openIdLookupEnabled });
    const abort = new AbortController(); const next: QQRuntime = { adapter, control, channel, abort, running: Promise.resolve(), stopping: false };
    next.running = channel.run(connection, abort.signal); void next.running.catch((error) => { if (!next.stopping) logger.error(error); }); qqRuntime = next;
  };

  const scheduleTelegram = (): void => { if (!active) return; telegramQueue = telegramQueue.then(reconcileTelegram, reconcileTelegram).catch((error: unknown) => { logger.error(error); }); };
  const scheduleQQ = (): void => { if (!active) return; qqQueue = qqQueue.then(reconcileQQ, reconcileQQ).catch((error: unknown) => { logger.error(error); }); };

  installSettingsSection(ctx, TELEGRAM_SETTINGS_NAMESPACE, TelegramSettingsSchema, { allowedUserIds: config.allowedUserIds, hostName: config.hostName }, { setSource: (current) => { telegramSource = current; }, onChange: () => { scheduleTelegram(); scheduleQQ(); } });
  installSettingsSection(ctx, QQ_SETTINGS_NAMESPACE, QQSettingsSchema, { appId: config.qqAppId, allowedOpenIds: config.qqAllowedOpenIds, progressIntervalMs: config.qqProgressIntervalMs, openIdLookupEnabled: config.qqOpenIdLookupEnabled }, { setSource: (current) => { qqSource = current; }, onChange: scheduleQQ });

  await ctx.effect(() => {
    active = true;
    const stopCredentialListener = ctx.on("credentials/updated", (ref) => { if (ref === TELEGRAM_BOT_TOKEN_REF) scheduleTelegram(); if (ref === QQ_BOT_APP_SECRET_REF) scheduleQQ(); });
    scheduleTelegram(); scheduleQQ();
    return async () => { active = false; stopCredentialListener(); await Promise.all([telegramQueue, qqQueue]); await Promise.all([stopTelegram(telegramRuntime), stopQQ(qqRuntime)]); telegramRuntime = undefined; qqRuntime = undefined; };
  }, "Telegram and QQ channel runtimes");
}

export { DshAdapter, CorrelatedTurnCollector } from "./dsh-adapter.js";

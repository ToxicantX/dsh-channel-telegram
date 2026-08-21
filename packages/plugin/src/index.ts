import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { TelegramGateway, createTelegramBot, registerTelegramCommands, sendTelegramDiagnosticReady } from "@dsh-channel-telegram/gateway";
import { DshAdapter } from "./dsh-adapter.js";

export const name = "dsh-channel-telegram";
export const inject = [
  "agentDefaultModel", "agentPresets", "agents", "credentials",
  "sessionQuery", "sessions", "workspaceRegistry"
];

export const TELEGRAM_BOT_TOKEN_REF = "TELEGRAM_BOT_TOKEN";
export const TELEGRAM_SETTINGS_NAMESPACE = settingsNamespace("telegram");
export const DEFAULT_HOST_NAME = "Local DSH";

export interface Config {
  readonly allowedUserIds: number[];
  readonly hostName: string;
  readonly turnTimeoutMs: number;
  readonly progressEditIntervalMs: number;
  readonly diagnosticLogging: boolean;
}

export const Config: z<Config> = z.object({
  allowedUserIds: z.array(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)).default([]),
  hostName: z.string().min(1).max(64).default(DEFAULT_HOST_NAME),
  turnTimeoutMs: z.number().step(1).min(1).default(600000),
  progressEditIntervalMs: z.number().step(1).min(1).default(1000),
  diagnosticLogging: z.boolean().default(false)
});

export interface TelegramRuntimeSettings {
  readonly allowedUserIds: number[];
  readonly hostName: string;
}

export const TelegramSettingsSchema: z<TelegramRuntimeSettings> = z.object({
  allowedUserIds: z.array(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)).default([]),
  hostName: z.string().min(1).max(64).default(DEFAULT_HOST_NAME)
});

export function normalizeTelegramSettings(config: Pick<Config, "allowedUserIds" | "hostName">): TelegramRuntimeSettings {
  const hostName = config.hostName.trim();
  if (hostName.length === 0 || hostName.length > 64) throw new Error("Telegram host name must contain 1 to 64 characters");
  const allowedUserIds = [...new Set(config.allowedUserIds)];
  if (allowedUserIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Telegram allowed user IDs must be positive safe integers");
  }
  return { allowedUserIds, hostName };
}

type TelegramBot = ReturnType<typeof createTelegramBot>;

interface ActiveRuntime {
  readonly adapter: DshAdapter;
  readonly gateway: TelegramGateway;
  readonly bot: TelegramBot;
  running: Promise<void>;
  stopping: boolean;
}

async function stopRuntime(runtime: ActiveRuntime | undefined): Promise<void> {
  if (runtime === undefined) return;
  runtime.stopping = true;
  runtime.gateway.dispose();
  try {
    await runtime.bot.stop();
  } finally {
    await runtime.running.catch(() => undefined);
    await runtime.adapter.dispose();
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger(name);
  let source = (): TelegramRuntimeSettings => ({ allowedUserIds: config.allowedUserIds, hostName: config.hostName });
  let active = false;
  let runtime: ActiveRuntime | undefined;
  let queue = Promise.resolve();

  const reconcile = async (): Promise<void> => {
    await stopRuntime(runtime);
    runtime = undefined;
    if (!active) return;

    const settings = normalizeTelegramSettings(source());
    const resolved = await ctx.credentials.resolve(credentialRef(TELEGRAM_BOT_TOKEN_REF));
    if (resolved === undefined || settings.allowedUserIds.length === 0) {
      logger.info("Telegram poller is disabled until a Bot Token and allowed user ID are configured");
      return;
    }

    const adapter = new DshAdapter(ctx, {
      turnTimeoutMs: config.turnTimeoutMs,
      hostName: settings.hostName
    });
    const gateway = new TelegramGateway(adapter, { allowedUserIds: settings.allowedUserIds });
    const bot = createTelegramBot(resolved.value, gateway, {
      progressEditIntervalMs: config.progressEditIntervalMs,
      ...(config.diagnosticLogging ? { onInbound: (metadata: unknown) => { logger.info("Telegram inbound", metadata); } } : {})
    });

    try {
      await registerTelegramCommands(bot);
    } catch (error) {
      logger.warn("Failed to register Telegram commands", error);
    }
    if (config.diagnosticLogging) {
      try {
        await sendTelegramDiagnosticReady(bot, settings.allowedUserIds);
      } catch (error) {
        logger.warn("Failed to send Telegram diagnostic readiness notice", error);
      }
    }

    const next: ActiveRuntime = { adapter, gateway, bot, running: Promise.resolve(), stopping: false };
    next.running = bot.start({ drop_pending_updates: false });
    void next.running.catch((error) => {
      if (!next.stopping) logger.error(error);
    });
    runtime = next;
  };

  const scheduleReconcile = (): void => {
    if (!active) return;
    queue = queue.then(reconcile, reconcile).catch((error: unknown) => {
      logger.error(error);
    });
  };

  installSettingsSection(ctx, TELEGRAM_SETTINGS_NAMESPACE, TelegramSettingsSchema, {
    allowedUserIds: config.allowedUserIds,
    hostName: config.hostName
  }, {
    setSource: (current) => { source = current; },
    onChange: scheduleReconcile
  });

  await ctx.effect(() => {
    active = true;
    const stopCredentialListener = ctx.on("credentials/updated", (ref) => {
      if (ref === TELEGRAM_BOT_TOKEN_REF) scheduleReconcile();
    });
    scheduleReconcile();
    return async () => {
      active = false;
      stopCredentialListener();
      await queue;
      await stopRuntime(runtime);
      runtime = undefined;
    };
  }, "telegram dynamic long poller");
}

export { DshAdapter, CorrelatedTurnCollector } from "./dsh-adapter.js";

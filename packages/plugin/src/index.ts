import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { TelegramGateway, createTelegramBot, registerTelegramCommands } from "@dsh-channel-telegram/gateway";
import { DshAdapter } from "./dsh-adapter.js";

export const name = "dsh-channel-telegram";
export const inject = [
  "agentDefaultModel", "agentPresets", "agents", "credentials",
  "sessionQuery", "sessions", "workspaceRegistry"
];

export interface Config {
  readonly tokenRef: string;
  readonly allowedUserIds: number[];
  readonly turnTimeoutMs: number;
  readonly progressEditIntervalMs: number;
  readonly diagnosticLogging: boolean;
  readonly agentPreset?: string;
}

export const Config: z<Config> = z.object({
  tokenRef: z.string().default("TELEGRAM_BOT_TOKEN"),
  allowedUserIds: z.array(z.number()).required(),
  turnTimeoutMs: z.number().default(600000),
  progressEditIntervalMs: z.number().default(1000),
  diagnosticLogging: z.boolean().default(false),
  agentPreset: z.string()
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = await ctx.credentials.resolve(credentialRef(config.tokenRef));
  if (resolved === undefined) throw new Error(`Telegram Bot Token is not configured at ${config.tokenRef}`);
  const adapter = new DshAdapter(ctx, { turnTimeoutMs: config.turnTimeoutMs, agentPreset: config.agentPreset });
  const gateway = new TelegramGateway(adapter, { allowedUserIds: config.allowedUserIds });
  const logger = ctx.logger(name);
  const bot = createTelegramBot(resolved.value, gateway, {
    progressEditIntervalMs: config.progressEditIntervalMs,
    ...(config.diagnosticLogging ? { onInbound: (metadata: unknown) => { logger.info("Telegram inbound", metadata); } } : {})
  });
  try {
    await registerTelegramCommands(bot);
  } catch (error) {
    logger.warn("Failed to register Telegram commands", error);
  }

  await ctx.effect(() => {
    let stopping = false;
    const running = bot.start({ drop_pending_updates: false });
    void running.catch((error) => {
      if (!stopping) logger.error(error);
    });
    return async () => {
      stopping = true;
      await bot.stop();
      await running.catch(() => undefined);
      await adapter.dispose();
    };
  }, "telegram long poller");
}

export { DshAdapter, CorrelatedTurnCollector } from "./dsh-adapter.js";

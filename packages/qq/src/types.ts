export const QQ_API_BASE = "https://api.bot.qq.com";
export const QQ_TOKEN_ENDPOINT = QQ_API_BASE + "/app/getAppAccessToken";
export const QQ_C2C_INTENT = 1 << 25;
export const QQ_INTERACTION_INTENT = 1 << 26;
export const QQ_GATEWAY_INTENTS = QQ_C2C_INTENT | QQ_INTERACTION_INTENT;

export class QQApiError extends Error {
  readonly name = "QQApiError";
  constructor(message: string, readonly status?: number, readonly code?: number | string) { super(message); }
}

export interface QQAccessToken { readonly value: string; readonly expiresAt: number; }

export interface QQC2CMessage {
  readonly id: string;
  readonly userOpenId: string;
  readonly content: string;
  readonly msgIndex?: string;
  readonly dedupeKey: string;
  readonly timestamp?: string;
}

export interface QQC2CInteraction {
  readonly id: string;
  readonly userOpenId: string;
  readonly data: string;
  readonly buttonId?: string;
  readonly dedupeKey: string;
}

export interface QQGatewayPayload { readonly op: number; readonly d?: unknown; readonly s?: number; readonly t?: string; readonly id?: string; }

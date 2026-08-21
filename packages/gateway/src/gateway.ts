import type {
  ControlCallbackResult,
  ControlOptions,
  ControlProgressListener,
  ControlReply,
  ControlSessionProgressListener
} from "./control.js";
import { DshControlPlane } from "./control.js";
import type { CallbackTokenStore, MenuView } from "./menu.js";
import type { DshPort, TelegramCallbackUpdate, TelegramTextUpdate, TurnProgress } from "./ports.js";

export type GatewayReply = ControlReply;
export type GatewayProgressListener = ControlProgressListener;

export interface GatewaySessionProgressEvent {
  readonly userId: number;
  readonly chatId: number;
  readonly progress: TurnProgress;
}

export type GatewaySessionProgressListener = (event: GatewaySessionProgressEvent) => void | Promise<void>;
export type GatewayCallbackResult = ControlCallbackResult;

export interface GatewayOptions {
  readonly allowedUserIds: readonly number[];
  readonly idempotencyCapacity?: number;
  readonly pageSize?: number;
  readonly callbackStore?: CallbackTokenStore;
}

export class TelegramGateway {
  private readonly allowed: Set<number>;
  private readonly control: DshControlPlane;

  constructor(dsh: DshPort, options: GatewayOptions) {
    if (options.allowedUserIds.length === 0) throw new Error("allowedUserIds must not be empty");
    if (options.allowedUserIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error("allowedUserIds must contain positive integers");
    }
    this.allowed = new Set(options.allowedUserIds);
    const controlOptions: ControlOptions = {
      ...(options.idempotencyCapacity === undefined ? {} : { idempotencyCapacity: options.idempotencyCapacity }),
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
      ...(options.callbackStore === undefined ? {} : { callbackStore: options.callbackStore })
    };
    this.control = new DshControlPlane(dsh, controlOptions);
  }

  async handle(update: TelegramTextUpdate, onProgress?: GatewayProgressListener): Promise<readonly GatewayReply[]> {
    if (!this.authorized(update)) return [];
    return this.control.handle({
      updateId: String(update.updateId),
      actorId: String(update.userId),
      conversationId: String(update.chatId),
      text: update.text
    }, onProgress);
  }

  async handleCallback(update: TelegramCallbackUpdate): Promise<GatewayCallbackResult> {
    if (!this.authorized(update)) return { answer: "Not authorized." };
    return this.control.handleCallback({
      updateId: String(update.updateId),
      actorId: String(update.userId),
      conversationId: String(update.chatId),
      data: update.data
    });
  }

  onSessionProgress(listener: GatewaySessionProgressListener): () => void {
    const mapped: ControlSessionProgressListener = ({ actorId, conversationId, progress }) => listener({
      userId: Number(actorId),
      chatId: Number(conversationId),
      progress
    });
    return this.control.onSessionProgress(mapped);
  }

  onDispose(listener: () => void): () => void {
    return this.control.onDispose(listener);
  }

  dispose(): void {
    this.control.dispose();
  }

  private authorized(update: { readonly chatType: string; readonly userId: number }): boolean {
    return update.chatType === "private" && this.allowed.has(update.userId);
  }
}

export type { MenuView };

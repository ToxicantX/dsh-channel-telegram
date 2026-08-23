export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface Credentials {
  readonly token: string;
  readonly baseUrl: string;
  readonly accountId: string;
  readonly userId: string;
  readonly savedAt: string;
}

export interface QrLoginCallbacks {
  readonly onQrUrl?: (url: string) => void;
  readonly onScanned?: () => void;
  readonly onExpired?: () => void;
  readonly onVerifyCode?: (isRetry: boolean) => string | Promise<string>;
}

export interface WeChatBotOptions {
  readonly baseUrl?: string;
  readonly storage?: "file" | "memory" | Storage;
  readonly storageDir?: string;
  readonly logLevel?: "silent" | "error" | "warn" | "info" | "debug";
  readonly loginCallbacks?: QrLoginCallbacks;
  readonly botAgent?: string;
  readonly fetch?: typeof fetch;
}

export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

export interface CDNMedia {
  readonly encrypt_query_param?: string;
  readonly aes_key?: string;
  readonly encrypt_type?: number;
  readonly full_url?: string;
}

export interface WireMessageItem {
  readonly type?: number;
  readonly text_item?: { readonly text?: string };
  readonly image_item?: { readonly media?: CDNMedia; readonly thumb_media?: CDNMedia; readonly aeskey?: string; readonly url?: string; readonly thumb_width?: number; readonly thumb_height?: number };
  readonly voice_item?: { readonly media?: CDNMedia; readonly text?: string; readonly playtime?: number; readonly encode_type?: number };
  readonly file_item?: { readonly media?: CDNMedia; readonly file_name?: string; readonly md5?: string; readonly len?: string };
  readonly video_item?: { readonly media?: CDNMedia; readonly thumb_media?: CDNMedia; readonly play_length?: number; readonly thumb_width?: number; readonly thumb_height?: number };
  readonly ref_msg?: { readonly title?: string; readonly message_item?: WireMessageItem };
}

export interface WireMessage {
  readonly seq?: number;
  readonly message_id?: number;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly client_id?: string;
  readonly create_time_ms?: number;
  readonly session_id?: string;
  readonly group_id?: string;
  readonly message_type?: number;
  readonly message_state?: number;
  readonly context_token?: string;
  readonly item_list?: readonly WireMessageItem[];
}

export interface IncomingMessage {
  readonly userId: string;
  readonly text: string;
  readonly type: "text" | "image" | "voice" | "file" | "video";
  readonly timestamp: Date;
  readonly images: readonly unknown[];
  readonly voices: readonly unknown[];
  readonly files: readonly unknown[];
  readonly videos: readonly unknown[];
  readonly raw: WireMessage;
  readonly _contextToken: string;
}

export type SendContent = string | { readonly text: string } | { readonly image: Buffer; readonly caption?: string } | { readonly video: Buffer; readonly caption?: string } | { readonly file: Buffer; readonly fileName: string; readonly caption?: string } | { readonly url: string; readonly fileName?: string; readonly caption?: string };

export interface GetUpdatesResponse {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly WireMessage[];
  readonly get_updates_buf?: string;
  readonly longpolling_timeout_ms?: number;
}

export interface GetConfigResponse { readonly ret?: number; readonly errcode?: number; readonly errmsg?: string; readonly typing_ticket?: string; }
export interface QrCodeResponse { readonly qrcode: string; readonly qrcode_img_content: string; }
export interface QrStatusResponse {
  readonly status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  readonly bot_token?: string;
  readonly ilink_bot_id?: string;
  readonly ilink_user_id?: string;
  readonly baseurl?: string;
  readonly redirect_host?: string;
}

export interface SendMessageRequest {
  readonly msg: {
    readonly from_user_id: string;
    readonly to_user_id: string;
    readonly client_id: string;
    readonly message_type: number;
    readonly message_state: number;
    readonly context_token: string;
    readonly item_list: readonly WireMessageItem[];
  };
}

export type WechatIncomingMessage = IncomingMessage;
export type WechatStorage = Storage;
export type WechatSdkOptions = WeChatBotOptions;

export interface WechatBotLike {
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): unknown;
  reply(message: IncomingMessage, content: SendContent): Promise<void>;
  send(userId: string, content: SendContent): Promise<void>;
  sendTyping(userId: string): Promise<void>;
  stopTyping(userId: string): Promise<void>;
}

export const PROTOCOL_VERSION = 1 as const;

export type RequestId = string;
export type IdempotencyId = string;
export type NodeId = string;

export interface NodeCapabilities {
  readonly catalog: boolean;
  readonly sessions: boolean;
  readonly approvals: boolean;
  readonly userQuestions: boolean;
  readonly attachments: boolean;
}

export interface ProtocolError {
  readonly code:
    | "BAD_MESSAGE"
    | "UNSUPPORTED_VERSION"
    | "UNAUTHORIZED"
    | "NOT_FOUND"
    | "CONFLICT"
    | "OFFLINE"
    | "TIMEOUT"
    | "DSH_ERROR";
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export type GatewayNodeMessage =
  | { readonly kind: "hello"; readonly nodeId: NodeId; readonly nonce: string; readonly capabilities: NodeCapabilities }
  | { readonly kind: "challenge"; readonly challenge: string; readonly expiresAt: number }
  | { readonly kind: "authenticate"; readonly nodeId: NodeId; readonly challenge: string; readonly signature: string }
  | { readonly kind: "authenticated"; readonly nodeId: NodeId; readonly connectionId: string }
  | { readonly kind: "heartbeat"; readonly sequence: number; readonly sentAt: number }
  | { readonly kind: "catalog/query"; readonly scope: "computers" | "projects" | "sessions"; readonly parentId?: string }
  | { readonly kind: "catalog/result"; readonly items: readonly CatalogItem[] }
  | { readonly kind: "session/command"; readonly sessionId: string; readonly idempotencyId: IdempotencyId; readonly command: SessionCommand }
  | { readonly kind: "session/event"; readonly sessionId: string; readonly turn?: number; readonly sequence: number; readonly event: SessionStreamEvent }
  | { readonly kind: "approval/request"; readonly nodeId: NodeId; readonly sessionId: string; readonly approvalId: string; readonly digest: string; readonly summary: string; readonly expiresAt: number }
  | { readonly kind: "approval/decision"; readonly approvalId: string; readonly digest: string; readonly decision: "allow-once" | "reject"; readonly userId: string }
  | { readonly kind: "question/request"; readonly nodeId: NodeId; readonly sessionId: string; readonly questionId: string; readonly prompt: string; readonly expiresAt: number }
  | { readonly kind: "question/answer"; readonly questionId: string; readonly answer: string; readonly userId: string }
  | { readonly kind: "error"; readonly error: ProtocolError };

export interface CatalogItem {
  readonly id: string;
  readonly parentId?: string;
  readonly title: string;
  readonly status?: string;
}

export type SessionCommand =
  | { readonly action: "send"; readonly text: string }
  | { readonly action: "stop"; readonly keepInbox: true }
  | { readonly action: "status" }
  | { readonly action: "create"; readonly workspaceId: string };

export type SessionStreamEvent =
  | { readonly type: "turn/start" }
  | { readonly type: "assistant/chunk"; readonly text: string }
  | { readonly type: "assistant/message"; readonly text: string }
  | { readonly type: "tool/status"; readonly tool: string; readonly status: "started" | "completed" | "failed" }
  | { readonly type: "turn/end"; readonly reason: string };

export interface Envelope<T extends GatewayNodeMessage = GatewayNodeMessage> {
  readonly version: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly requestId?: RequestId;
  readonly timestamp: number;
  readonly message: T;
}

const kinds = new Set<GatewayNodeMessage["kind"]>([
  "hello", "challenge", "authenticate", "authenticated", "heartbeat",
  "catalog/query", "catalog/result", "session/command", "session/event",
  "approval/request", "approval/decision", "question/request",
  "question/answer", "error"
]);

export class ProtocolValidationError extends Error {
  constructor(readonly code: ProtocolError["code"], message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

export function parseEnvelope(value: unknown): Envelope {
  if (!isRecord(value)) throw new ProtocolValidationError("BAD_MESSAGE", "Envelope must be an object");
  if (value.version !== PROTOCOL_VERSION) throw new ProtocolValidationError("UNSUPPORTED_VERSION", "Unsupported protocol version");
  if (!isNonEmpty(value.messageId)) throw new ProtocolValidationError("BAD_MESSAGE", "messageId is required");
  if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) throw new ProtocolValidationError("BAD_MESSAGE", "timestamp is invalid");
  if (!isRecord(value.message) || !isNonEmpty(value.message.kind) || !kinds.has(value.message.kind as GatewayNodeMessage["kind"])) {
    throw new ProtocolValidationError("BAD_MESSAGE", "Unknown message kind");
  }
  if (value.requestId !== undefined && !isNonEmpty(value.requestId)) throw new ProtocolValidationError("BAD_MESSAGE", "requestId is invalid");
  return value as unknown as Envelope;
}

export function makeEnvelope<T extends GatewayNodeMessage>(messageId: string, message: T, requestId?: RequestId, timestamp = Date.now()): Envelope<T> {
  return parseEnvelope({ version: PROTOCOL_VERSION, messageId, requestId, timestamp, message }) as Envelope<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

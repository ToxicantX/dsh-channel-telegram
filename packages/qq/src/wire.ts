import type { QQC2CMessage, QQGatewayPayload } from "./types.js";

export function decodeGatewayPayload(raw: unknown): QQGatewayPayload | undefined {
  let value = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { return undefined; } }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.op)) return undefined;
  return { op: record.op as number, ...(record.d === undefined ? {} : { d: record.d }), ...(typeof record.s === "number" ? { s: record.s } : {}), ...(typeof record.t === "string" ? { t: record.t } : {}), ...(typeof record.id === "string" ? { id: record.id } : {}) };
}

export function decodeC2CMessage(payload: QQGatewayPayload): QQC2CMessage | undefined {
  if (payload.op !== 0 || payload.t !== "C2C_MESSAGE_CREATE" || typeof payload.d !== "object" || payload.d === null) return undefined;
  const data = payload.d as Record<string, unknown>;
  const author = data.author;
  if (typeof data.id !== "string" || typeof data.content !== "string" || typeof author !== "object" || author === null) return undefined;
  const actor = author as Record<string, unknown>;
  const userOpenId = typeof actor.user_openid === "string" && actor.user_openid !== "" ? actor.user_openid : typeof actor.id === "string" ? actor.id : undefined;
  if (userOpenId === undefined || userOpenId === "") return undefined;
  const scene = data.message_scene;
  const ext = typeof scene === "object" && scene !== null && Array.isArray((scene as { ext?: unknown }).ext) ? (scene as { ext: unknown[] }).ext : [];
  const msgIndexEntry = ext.find((item) => typeof item === "string" && item.startsWith("msg_idx="));
  const msgIndex = typeof msgIndexEntry === "string" ? msgIndexEntry.slice(8) : undefined;
  return { id: data.id, userOpenId, content: data.content.trim(), ...(msgIndex === undefined || msgIndex === "" ? {} : { msgIndex }), dedupeKey: data.id + ":" + (msgIndex ?? ""), ...(typeof data.timestamp === "string" ? { timestamp: data.timestamp } : {}) };
}

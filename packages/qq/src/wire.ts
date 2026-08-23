import type { QQC2CInteraction, QQC2CMessage, QQGatewayPayload } from "./types.js";

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

export function decodeC2CInteraction(payload: QQGatewayPayload): QQC2CInteraction | undefined {
  if (payload.op !== 0 || payload.t !== "INTERACTION_CREATE" || typeof payload.d !== "object" || payload.d === null) return undefined;
  const value = payload.d as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id === "" || typeof value.user_openid !== "string" || value.user_openid === "") return undefined;
  if (value.chat_type !== 2 && value.scene !== "c2c") return undefined;
  if (typeof value.data !== "object" || value.data === null) return undefined;
  const resolved = (value.data as Record<string, unknown>).resolved;
  if (typeof resolved !== "object" || resolved === null) return undefined;
  const record = resolved as Record<string, unknown>;
  if (typeof record.button_data !== "string" || record.button_data === "") return undefined;
  return {
    id: value.id,
    userOpenId: value.user_openid,
    data: record.button_data,
    ...(typeof record.button_id === "string" && record.button_id !== "" ? { buttonId: record.button_id } : {}),
    dedupeKey: "interaction:" + value.id
  };
}

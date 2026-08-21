export interface TelegramSettingsDraft {
  readonly hostName: string;
  readonly allowedUserIds: number[];
}

export interface DraftValidation {
  readonly value?: TelegramSettingsDraft;
  readonly hostNameError?: string;
  readonly userIdsError?: string;
}

export function parseTelegramSettingsDraft(hostNameInput: string, userIdsInput: string): DraftValidation {
  const hostName = hostNameInput.trim();
  const hostNameError = hostName.length === 0
    ? "Host name is required"
    : hostName.length > 64 ? "Host name must be 64 characters or fewer" : undefined;

  const pieces = userIdsInput.split(/[\s,]+/u).filter(Boolean);
  const allowedUserIds: number[] = [];
  let userIdsError: string | undefined;
  for (const piece of pieces) {
    if (!/^[0-9]+$/u.test(piece)) { userIdsError = "User IDs must contain digits only"; break; }
    const id = Number(piece);
    if (!Number.isSafeInteger(id) || id <= 0) { userIdsError = "User IDs must be positive safe integers"; break; }
    if (!allowedUserIds.includes(id)) allowedUserIds.push(id);
  }
  if (allowedUserIds.length === 0 && userIdsError === undefined) userIdsError = "Add at least one Telegram user ID";
  if (hostNameError !== undefined || userIdsError !== undefined) return { hostNameError, userIdsError };
  return { value: { hostName, allowedUserIds } };
}

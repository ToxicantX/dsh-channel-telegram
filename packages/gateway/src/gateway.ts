import type { MenuAction, MenuView } from "./menu.js";
import { CallbackTokenStore, paginate } from "./menu.js";
import type { DshPort, TelegramCallbackUpdate, TelegramTextUpdate, TurnProgress } from "./ports.js";
import { BoundedIdSet, KeyedSerialQueue } from "./queue.js";

interface Selection {
  computerId?: string;
  projectId?: string;
  sessionId?: string;
}

interface SessionWatchBinding {
  readonly key: string;
  readonly userId: number;
  readonly chatId: number;
  readonly sessionId: string;
  unwatch: () => void;
  suppressDirect: boolean;
}

export type GatewayReply = string | MenuView;
export type GatewayProgressListener = (progress: TurnProgress) => void | Promise<void>;

export interface GatewaySessionProgressEvent {
  readonly userId: number;
  readonly chatId: number;
  readonly progress: TurnProgress;
}

export type GatewaySessionProgressListener = (event: GatewaySessionProgressEvent) => void | Promise<void>;

export interface GatewayCallbackResult {
  readonly answer: string;
  readonly view?: MenuView;
}

export interface GatewayOptions {
  readonly allowedUserIds: readonly number[];
  readonly idempotencyCapacity?: number;
  readonly pageSize?: number;
  readonly callbackStore?: CallbackTokenStore;
}

export class TelegramGateway {
  private readonly allowed: Set<number>;
  private readonly seen: BoundedIdSet;
  private readonly queues = new KeyedSerialQueue();
  private readonly relayQueues = new KeyedSerialQueue();
  private readonly selections = new Map<string, Selection>();
  private readonly watches = new Map<string, SessionWatchBinding>();
  private readonly sessionListeners = new Set<GatewaySessionProgressListener>();
  private readonly disposeListeners = new Set<() => void>();
  private readonly callbacks: CallbackTokenStore;
  private readonly pageSize: number;
  private disposed = false;

  constructor(private readonly dsh: DshPort, options: GatewayOptions) {
    if (options.allowedUserIds.length === 0) throw new Error("allowedUserIds must not be empty");
    if (options.allowedUserIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("allowedUserIds must contain positive integers");
    this.allowed = new Set(options.allowedUserIds);
    this.seen = new BoundedIdSet(options.idempotencyCapacity);
    this.callbacks = options.callbackStore ?? new CallbackTokenStore();
    this.pageSize = options.pageSize ?? 8;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1) throw new Error("pageSize must be positive");
  }

  onSessionProgress(listener: GatewaySessionProgressListener): () => void {
    if (this.disposed) return () => undefined;
    this.sessionListeners.add(listener);
    return () => { this.sessionListeners.delete(listener); };
  }

  onDispose(listener: () => void): () => void {
    if (this.disposed) { listener(); return () => undefined; }
    this.disposeListeners.add(listener);
    return () => { this.disposeListeners.delete(listener); };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const binding of this.watches.values()) binding.unwatch();
    this.watches.clear();
    for (const listener of this.disposeListeners) listener();
    this.disposeListeners.clear();
    this.sessionListeners.clear();
  }

  async handle(update: TelegramTextUpdate, onProgress?: GatewayProgressListener): Promise<readonly GatewayReply[]> {
    if (!this.authorized(update)) return [];
    if (!this.seen.addIfNew(String(update.chatId) + ":" + String(update.updateId))) return [];
    const text = update.text.trim();
    if (text === "") return [];
    if (!text.startsWith("/")) {
      const reply = await this.sendText(update.userId, update.chatId, text, onProgress);
      return reply === undefined ? [] : [reply];
    }

    const [rawCommand = "", ...args] = text.split(/\s+/u);
    const command = rawCommand.split("@", 1)[0]?.toLowerCase();
    switch (command) {
      case "/start":
      case "/menu": return [await this.rootMenu(update.userId, update.chatId)];
      case "/computers": return [await this.computersMenu(update.userId, update.chatId, 0)];
      case "/projects": return [await this.projectsEntry(update.userId, update.chatId)];
      case "/sessions": return [await this.sessionsEntry(update.userId, update.chatId)];
      case "/use": return [await this.use(update.userId, update.chatId, args)];
      case "/new": return [await this.create(update.userId, update.chatId)];
      case "/status": return [await this.rootMenu(update.userId, update.chatId)];
      case "/stop": return [await this.stop(update.userId, update.chatId)];
      default: return ["Commands: /start /menu /computers /projects /sessions /use /new /status /stop"];
    }
  }

  async handleCallback(update: TelegramCallbackUpdate): Promise<GatewayCallbackResult> {
    if (!this.authorized(update)) return { answer: "Not authorized." };
    if (!this.seen.addIfNew("callback:" + String(update.chatId) + ":" + String(update.updateId))) return { answer: "Already handled." };
    const action = this.callbacks.consume(update.data, update.userId, update.chatId);
    if (action === undefined) return { answer: "This menu expired. Run /menu again." };
    try {
      return await this.applyMenuAction(update.userId, update.chatId, action);
    } catch {
      return { answer: "Unable to refresh this menu." };
    }
  }

  private authorized(update: { readonly chatType: string; readonly userId: number }): boolean {
    return update.chatType === "private" && this.allowed.has(update.userId);
  }

  private selectionKey(userId: number, chatId: number): string {
    return String(userId) + ":" + String(chatId);
  }

  private selection(userId: number, chatId: number): Selection {
    const key = this.selectionKey(userId, chatId);
    let value = this.selections.get(key);
    if (value === undefined) {
      value = {};
      this.selections.set(key, value);
    }
    return value;
  }

  private issue(userId: number, chatId: number, text: string, action: MenuAction) {
    return { text, callbackData: this.callbacks.issue(userId, chatId, action) };
  }

  private clearWatch(userId: number, chatId: number): void {
    const key = this.selectionKey(userId, chatId);
    const binding = this.watches.get(key);
    if (binding === undefined) return;
    binding.unwatch();
    this.watches.delete(key);
  }

  private bindWatch(userId: number, chatId: number, sessionId: string): void {
    const key = this.selectionKey(userId, chatId);
    const existing = this.watches.get(key);
    if (existing !== undefined && existing.sessionId === sessionId) return;
    this.clearWatch(userId, chatId);
    const binding: SessionWatchBinding = {
      key,
      userId,
      chatId,
      sessionId,
      suppressDirect: false,
      unwatch: () => undefined
    };
    const unwatch = this.dsh.watchSession(sessionId, (progress) => {
      const suppressDirect = binding.suppressDirect;
      void this.relayQueues.run(key, async () => {
        const current = this.watches.get(key);
        if (current !== binding) return;
        if (suppressDirect || current.suppressDirect) return;
        const selected = this.selections.get(key);
        if (selected === undefined || selected.sessionId !== sessionId) return;
        if (this.disposed) return;
        const event: GatewaySessionProgressEvent = { userId, chatId, progress };
        for (const listener of this.sessionListeners) await listener(event);
      }).catch(() => undefined);
    });
    binding.unwatch = unwatch;
    this.watches.set(key, binding);
  }

  private setSession(userId: number, chatId: number, selected: Selection, sessionId: string | undefined): void {
    selected.sessionId = sessionId;
    if (sessionId === undefined) this.clearWatch(userId, chatId);
    else this.bindWatch(userId, chatId, sessionId);
  }

  private async applyMenuAction(userId: number, chatId: number, action: MenuAction): Promise<GatewayCallbackResult> {
    const selected = this.selection(userId, chatId);
    switch (action.type) {
      case "root": return { answer: "Refreshed.", view: await this.rootMenu(userId, chatId) };
      case "computers": return { answer: "Computers", view: await this.computersMenu(userId, chatId, action.page) };
      case "select-computer": {
        const computer = (await this.dsh.listComputers()).find((item) => item.id === action.computerId && item.status === "online");
        if (computer === undefined) return { answer: "Computer is offline or missing." };
        selected.computerId = computer.id;
        selected.projectId = undefined;
        this.setSession(userId, chatId, selected, undefined);
        return { answer: "Computer selected.", view: await this.projectsMenu(userId, chatId, computer.id, 0) };
      }
      case "projects": {
        if (selected.computerId !== action.computerId) return { answer: "Computer selection changed." };
        return { answer: "Projects", view: await this.projectsMenu(userId, chatId, action.computerId, action.page) };
      }
      case "select-project": {
        if (selected.computerId !== action.computerId) return { answer: "Computer selection changed." };
        const project = (await this.dsh.listProjects(action.computerId)).find((item) => item.id === action.projectId);
        if (project === undefined) return { answer: "Project is no longer available." };
        selected.projectId = project.id;
        this.setSession(userId, chatId, selected, undefined);
        return { answer: "Project selected.", view: await this.sessionsMenu(userId, chatId, action.computerId, project.id, 0) };
      }
      case "sessions": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        return { answer: "Sessions", view: await this.sessionsMenu(userId, chatId, action.computerId, action.projectId, action.page) };
      }
      case "select-session": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        const session = (await this.dsh.listSessions(action.computerId, action.projectId)).find((item) => item.id === action.sessionId);
        if (session === undefined) return { answer: "Session is no longer available." };
        this.setSession(userId, chatId, selected, session.id);
        return { answer: "Session selected.", view: await this.rootMenu(userId, chatId) };
      }
      case "presets": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        return { answer: "Presets", view: await this.presetsMenu(userId, chatId, action.computerId, action.projectId, action.page) };
      }
      case "create-session": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        const computer = (await this.dsh.listComputers()).find((item) => item.id === action.computerId && item.status === "online");
        if (computer === undefined) return { answer: "Computer is offline or missing." };
        const project = (await this.dsh.listProjects(action.computerId)).find((item) => item.id === action.projectId);
        if (project === undefined) return { answer: "Project is no longer available." };
        const preset = (await this.dsh.listAgentPresets()).find((item) => item.id === action.presetId);
        if (preset === undefined) return { answer: "Preset is no longer available." };
        const session = await this.dsh.createSession(action.computerId, action.projectId, preset.id);
        this.setSession(userId, chatId, selected, session.id);
        return { answer: "Session created.", view: await this.rootMenu(userId, chatId) };
      }
    }
  }

  private async rootMenu(userId: number, chatId: number): Promise<MenuView> {
    const selected = this.selection(userId, chatId);
    const status = selected.sessionId === undefined ? "not selected" : await this.dsh.status(selected.sessionId);
    const text = [
      "Current target",
      "Computer: " + (selected.computerId ?? "not selected"),
      "Project: " + (selected.projectId ?? "not selected"),
      "Session: " + (selected.sessionId ?? "not selected"),
      "Status: " + status
    ].join("\n");
    return { text, rows: [
      [this.issue(userId, chatId, "Computers", { type: "computers", page: 0 })],
      [this.issue(userId, chatId, "Projects", selected.computerId === undefined ? { type: "computers", page: 0 } : { type: "projects", computerId: selected.computerId, page: 0 })],
      [this.issue(userId, chatId, "Sessions", selected.computerId === undefined ? { type: "computers", page: 0 } : selected.projectId === undefined ? { type: "projects", computerId: selected.computerId, page: 0 } : { type: "sessions", computerId: selected.computerId, projectId: selected.projectId, page: 0 })],
      [this.issue(userId, chatId, "New session", selected.computerId === undefined ? { type: "computers", page: 0 } : selected.projectId === undefined ? { type: "projects", computerId: selected.computerId, page: 0 } : { type: "presets", computerId: selected.computerId, projectId: selected.projectId, page: 0 })],
      [this.issue(userId, chatId, "Refresh", { type: "root" })]
    ] };
  }

  private async computersMenu(userId: number, chatId: number, page: number): Promise<MenuView> {
    const selected = this.selection(userId, chatId);
    const values = paginate(await this.dsh.listComputers(), page, this.pageSize);
    const rows = values.items.map((item) => [this.issue(userId, chatId, (selected.computerId === item.id ? "* " : "") + compact(item.title, 40) + " (" + item.status + ")", { type: "select-computer", computerId: item.id })]);
    rows.push(this.navigation(userId, chatId, values.page, values.pages, (next) => ({ type: "computers", page: next })));
    rows.push([this.issue(userId, chatId, "Back", { type: "root" }), this.issue(userId, chatId, "Refresh", { type: "computers", page: values.page })]);
    return { text: "Select a computer (page " + String(values.page + 1) + "/" + String(values.pages) + ")", rows };
  }

  private async projectsEntry(userId: number, chatId: number): Promise<MenuView> {
    const selected = this.selection(userId, chatId);
    return selected.computerId === undefined ? this.computersMenu(userId, chatId, 0) : this.projectsMenu(userId, chatId, selected.computerId, 0);
  }

  private async projectsMenu(userId: number, chatId: number, computerId: string, page: number): Promise<MenuView> {
    const selected = this.selection(userId, chatId);
    const values = paginate(await this.dsh.listProjects(computerId), page, this.pageSize);
    const rows = values.items.map((item) => [this.issue(userId, chatId, (selected.projectId === item.id ? "* " : "") + compact(item.title, 40) + " (" + item.status + ")", { type: "select-project", computerId, projectId: item.id })]);
    rows.push(this.navigation(userId, chatId, values.page, values.pages, (next) => ({ type: "projects", computerId, page: next })));
    rows.push([this.issue(userId, chatId, "Back", { type: "computers", page: 0 }), this.issue(userId, chatId, "Refresh", { type: "projects", computerId, page: values.page })]);
    return { text: "Select a project (page " + String(values.page + 1) + "/" + String(values.pages) + ")", rows };
  }

  private async sessionsEntry(userId: number, chatId: number): Promise<MenuView> {
    const selected = this.selection(userId, chatId);
    if (selected.computerId === undefined) return this.computersMenu(userId, chatId, 0);
    if (selected.projectId === undefined) return this.projectsMenu(userId, chatId, selected.computerId, 0);
    return this.sessionsMenu(userId, chatId, selected.computerId, selected.projectId, 0);
  }

  private async sessionsMenu(userId: number, chatId: number, computerId: string, projectId: string, page: number): Promise<MenuView> {
    const selected = this.selection(userId, chatId);
    const values = paginate(await this.dsh.listSessions(computerId, projectId), page, this.pageSize);
    const rows = values.items.map((item) => [this.issue(userId, chatId, (selected.sessionId === item.id ? "* " : "") + compact(item.title, 40) + " (" + item.status + ")", { type: "select-session", computerId, projectId, sessionId: item.id })]);
    rows.push(this.navigation(userId, chatId, values.page, values.pages, (next) => ({ type: "sessions", computerId, projectId, page: next })));
    rows.push([this.issue(userId, chatId, "Back", { type: "projects", computerId, page: 0 }), this.issue(userId, chatId, "Refresh", { type: "sessions", computerId, projectId, page: values.page })]);
    return { text: "Select a session (page " + String(values.page + 1) + "/" + String(values.pages) + ")", rows };
  }

  private async presetsMenu(userId: number, chatId: number, computerId: string, projectId: string, page: number): Promise<MenuView> {
    const values = paginate(await this.dsh.listAgentPresets(), page, this.pageSize);
    const rows = values.items.map((item) => {
      const mark = item.isDefault ? "* " : "";
      return [this.issue(userId, chatId, mark + compact(item.title, 40), { type: "create-session", computerId, projectId, presetId: item.id })];
    });
    rows.push(this.navigation(userId, chatId, values.page, values.pages, (next) => ({ type: "presets", computerId, projectId, page: next })));
    rows.push([this.issue(userId, chatId, "Back", { type: "root" }), this.issue(userId, chatId, "Refresh", { type: "presets", computerId, projectId, page: values.page })]);
    const text = values.items.length === 0
      ? "No available Agent presets."
      : "Select an Agent preset (page " + String(values.page + 1) + "/" + String(values.pages) + ")";
    return { text, rows };
  }

  private navigation(userId: number, chatId: number, page: number, pages: number, action: (page: number) => MenuAction) {
    const row = [];
    if (page > 0) row.push(this.issue(userId, chatId, "Previous", action(page - 1)));
    if (page + 1 < pages) row.push(this.issue(userId, chatId, "Next", action(page + 1)));
    return row;
  }

  private async use(userId: number, chatId: number, args: readonly string[]): Promise<string> {
    const [kind, id] = args;
    const selected = this.selection(userId, chatId);
    if (kind === "computer" && id !== undefined) {
      if (!(await this.dsh.listComputers()).some((item) => item.id === id && item.status === "online")) return "Unknown computer.";
      selected.computerId = id; selected.projectId = undefined;
      this.setSession(userId, chatId, selected, undefined);
      return "Computer selected: " + id;
    }
    if (kind === "project" && id !== undefined) {
      if (selected.computerId === undefined) return "Select a computer first.";
      if (!(await this.dsh.listProjects(selected.computerId)).some((item) => item.id === id)) return "Unknown project.";
      selected.projectId = id;
      this.setSession(userId, chatId, selected, undefined);
      return "Project selected: " + id;
    }
    if (kind === "session" && id !== undefined) {
      if (selected.computerId === undefined || selected.projectId === undefined) return "Select a computer and project first.";
      if (!(await this.dsh.listSessions(selected.computerId, selected.projectId)).some((item) => item.id === id)) return "Unknown session for the selected project.";
      this.setSession(userId, chatId, selected, id);
      return "Session selected: " + id;
    }
    return "Usage: /use computer <id>, /use project <id>, or /use session <id>.";
  }

  private async create(userId: number, chatId: number): Promise<GatewayReply> {
    const selected = this.selection(userId, chatId);
    if (selected.computerId === undefined || selected.projectId === undefined) return "Select a computer and project first.";
    return this.presetsMenu(userId, chatId, selected.computerId, selected.projectId, 0);
  }

  private async stop(userId: number, chatId: number): Promise<string> {
    const sessionId = this.selection(userId, chatId).sessionId;
    if (sessionId === undefined) return "No session selected.";
    return (await this.dsh.stop(sessionId)) ? "Stop requested; queued work was preserved." : "No live turn to stop.";
  }

  private async sendText(userId: number, chatId: number, text: string, onProgress?: GatewayProgressListener): Promise<string | undefined> {
    const sessionId = this.selection(userId, chatId).sessionId;
    if (sessionId === undefined) return "Select a session from /menu.";
    const key = this.selectionKey(userId, chatId);
    let progressTail = Promise.resolve();
    const emit = onProgress === undefined ? undefined : (progress: TurnProgress) => {
      progressTail = progressTail.then(() => onProgress(progress)).then(() => undefined);
    };
    if (emit !== undefined) emit({ type: "queued", sessionId });
    try {
      const result = await this.queues.run(sessionId, () => this.relayQueues.run(key, async () => {
        const binding = this.watches.get(key);
        if (binding !== undefined && binding.sessionId === sessionId) binding.suppressDirect = true;
        try {
          return await this.dsh.send(sessionId, text, emit);
        } finally {
          if (binding !== undefined) binding.suppressDirect = false;
        }
      }));
      await progressTail;
      if (onProgress !== undefined) return undefined;
      return result.text !== "" ? result.text : "Turn " + String(result.turn) + " ended: " + result.reason + ".";
    } catch {
      if (emit !== undefined) {
        emit({ type: "failed", sessionId, message: "DSH request failed." });
        await progressTail;
        return undefined;
      }
      return "DSH request failed.";
    }
  }
}

function compact(value: string, length: number): string {
  return value.length <= length ? value : value.slice(0, Math.max(1, length - 3)) + "...";
}

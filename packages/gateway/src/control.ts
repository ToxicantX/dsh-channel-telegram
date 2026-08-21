import type { MenuAction, MenuView } from "./menu.js";
import { CallbackTokenStore, paginate } from "./menu.js";
import type { DshPort, TurnProgress } from "./ports.js";
import { BoundedIdSet, KeyedSerialQueue } from "./queue.js";

export interface ControlTextUpdate {
  readonly updateId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly text: string;
}

export interface ControlCallbackUpdate {
  readonly updateId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly data: string;
}

interface Selection {
  computerId?: string;
  projectId?: string;
  sessionId?: string;
}

interface SessionWatchBinding {
  readonly key: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  unwatch: () => void;
  suppressDirect: boolean;
}

export type ControlReply = string | MenuView;
export type ControlProgressListener = (progress: TurnProgress) => void | Promise<void>;

export interface ControlSessionProgressEvent {
  readonly actorId: string;
  readonly conversationId: string;
  readonly progress: TurnProgress;
}

export type ControlSessionProgressListener = (event: ControlSessionProgressEvent) => void | Promise<void>;

export interface ControlCallbackResult {
  readonly answer: string;
  readonly view?: MenuView;
}

export interface ControlOptions {
  readonly idempotencyCapacity?: number;
  readonly pageSize?: number;
  readonly callbackStore?: CallbackTokenStore;
}

export class DshControlPlane {
  private readonly seen: BoundedIdSet;
  private readonly queues = new KeyedSerialQueue();
  private readonly conversationQueues = new KeyedSerialQueue();
  private readonly relayQueues = new KeyedSerialQueue();
  private readonly selections = new Map<string, Selection>();
  private readonly watches = new Map<string, SessionWatchBinding>();
  private readonly sessionListeners = new Set<ControlSessionProgressListener>();
  private readonly disposeListeners = new Set<() => void>();
  private readonly callbacks: CallbackTokenStore;
  private readonly pageSize: number;
  private disposed = false;

  constructor(private readonly dsh: DshPort, options: ControlOptions) {
    this.seen = new BoundedIdSet(options.idempotencyCapacity);
    this.callbacks = options.callbackStore ?? new CallbackTokenStore();
    this.pageSize = options.pageSize ?? 8;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1) throw new Error("pageSize must be positive");
  }

  onSessionProgress(listener: ControlSessionProgressListener): () => void {
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
    this.selections.clear();
    const listeners = [...this.disposeListeners];
    this.disposeListeners.clear();
    this.sessionListeners.clear();
    for (const listener of listeners) listener();
  }

  async handle(update: ControlTextUpdate, onProgress?: ControlProgressListener): Promise<readonly ControlReply[]> {
    if (this.disposed) return [];
    const actorId = String(update.actorId);
    const conversationId = String(update.conversationId);
    const updateId = String(update.updateId);
    if (!this.seen.addIfNew(this.idempotencyKey("text", actorId, conversationId, updateId))) return [];
    const text = update.text.trim();
    if (text === "") return [];
    const key = this.selectionKey(actorId, conversationId);
    // Stop must interrupt an active send instead of waiting behind it.
    if (commandOf(text) === "/stop") return [await this.stop(actorId, conversationId)];
    return this.conversationQueues.run(key, () => this.handleText(actorId, conversationId, text, onProgress));
  }

  private async handleText(actorId: string, conversationId: string, text: string, onProgress?: ControlProgressListener): Promise<readonly ControlReply[]> {
    if (this.disposed) return [];
    if (!text.startsWith("/")) {
      const reply = await this.sendText(actorId, conversationId, text, onProgress);
      return reply === undefined ? [] : [reply];
    }

    const [rawCommand = "", ...args] = text.split(/\s+/u);
    const command = rawCommand.split("@", 1)[0]?.toLowerCase();
    switch (command) {
      case "/start":
      case "/menu": return [await this.rootMenu(actorId, conversationId)];
      case "/computers": return [await this.computersMenu(actorId, conversationId, 0)];
      case "/projects": return [await this.projectsEntry(actorId, conversationId)];
      case "/sessions": return [await this.sessionsEntry(actorId, conversationId)];
      case "/use": return [await this.use(actorId, conversationId, args)];
      case "/new": return [await this.create(actorId, conversationId)];
      case "/status": return [await this.rootMenu(actorId, conversationId)];
      case "/stop": return [await this.stop(actorId, conversationId)];
      default: return ["Commands: /start /menu /computers /projects /sessions /use /new /status /stop"];
    }
  }

  async handleCallback(update: ControlCallbackUpdate): Promise<ControlCallbackResult> {
    if (this.disposed) return { answer: "This menu expired. Run /menu again." };
    const actorId = String(update.actorId);
    const conversationId = String(update.conversationId);
    const updateId = String(update.updateId);
    if (!this.seen.addIfNew(this.idempotencyKey("callback", actorId, conversationId, updateId))) return { answer: "Already handled." };
    const key = this.selectionKey(actorId, conversationId);
    return this.conversationQueues.run(key, async () => {
      if (this.disposed) return { answer: "This menu expired. Run /menu again." };
      const action = this.callbacks.consume(update.data, actorId, conversationId);
      if (action === undefined) return { answer: "This menu expired. Run /menu again." };
      try {
        return await this.applyMenuAction(actorId, conversationId, action);
      } catch {
        return { answer: "Unable to refresh this menu." };
      }
    });
  }


  private idempotencyKey(kind: "text" | "callback", actorId: string, conversationId: string, updateId: string): string {
    return kind + "|" + compositeKey(actorId, conversationId) + "|" + keyPart(updateId);
  }

  private selectionKey(actorId: string, conversationId: string): string {
    return compositeKey(actorId, conversationId);
  }

  private selection(actorId: string, conversationId: string): Selection {
    const key = this.selectionKey(actorId, conversationId);
    let value = this.selections.get(key);
    if (value === undefined) {
      value = {};
      this.selections.set(key, value);
    }
    return value;
  }

  private issue(actorId: string, conversationId: string, text: string, action: MenuAction) {
    return { text, callbackData: this.callbacks.issue(actorId, conversationId, action) };
  }

  private clearWatch(actorId: string, conversationId: string): void {
    const key = this.selectionKey(actorId, conversationId);
    const binding = this.watches.get(key);
    if (binding === undefined) return;
    binding.unwatch();
    this.watches.delete(key);
  }

  private bindWatch(actorId: string, conversationId: string, sessionId: string): void {
    const key = this.selectionKey(actorId, conversationId);
    const existing = this.watches.get(key);
    if (existing !== undefined && existing.sessionId === sessionId) return;
    this.clearWatch(actorId, conversationId);
    const binding: SessionWatchBinding = {
      key,
      actorId,
      conversationId,
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
        const event: ControlSessionProgressEvent = { actorId, conversationId, progress };
        for (const listener of this.sessionListeners) await listener(event);
      }).catch(() => undefined);
    });
    binding.unwatch = unwatch;
    this.watches.set(key, binding);
  }

  private setSession(actorId: string, conversationId: string, selected: Selection, sessionId: string | undefined): void {
    selected.sessionId = sessionId;
    if (sessionId === undefined) this.clearWatch(actorId, conversationId);
    else this.bindWatch(actorId, conversationId, sessionId);
  }

  private async applyMenuAction(actorId: string, conversationId: string, action: MenuAction): Promise<ControlCallbackResult> {
    const selected = this.selection(actorId, conversationId);
    switch (action.type) {
      case "root": return { answer: "Refreshed.", view: await this.rootMenu(actorId, conversationId) };
      case "computers": return { answer: "Computers", view: await this.computersMenu(actorId, conversationId, action.page) };
      case "select-computer": {
        const computer = (await this.dsh.listComputers()).find((item) => item.id === action.computerId && item.status === "online");
        if (computer === undefined) return { answer: "Computer is offline or missing." };
        selected.computerId = computer.id;
        selected.projectId = undefined;
        this.setSession(actorId, conversationId, selected, undefined);
        return { answer: "Computer selected.", view: await this.projectsMenu(actorId, conversationId, computer.id, 0) };
      }
      case "projects": {
        if (selected.computerId !== action.computerId) return { answer: "Computer selection changed." };
        return { answer: "Projects", view: await this.projectsMenu(actorId, conversationId, action.computerId, action.page) };
      }
      case "select-project": {
        if (selected.computerId !== action.computerId) return { answer: "Computer selection changed." };
        const project = (await this.dsh.listProjects(action.computerId)).find((item) => item.id === action.projectId);
        if (project === undefined || project.status !== "online") return { answer: "Project is no longer available." };
        selected.projectId = project.id;
        this.setSession(actorId, conversationId, selected, undefined);
        return { answer: "Project selected.", view: await this.sessionsMenu(actorId, conversationId, action.computerId, project.id, 0) };
      }
      case "sessions": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        return { answer: "Sessions", view: await this.sessionsMenu(actorId, conversationId, action.computerId, action.projectId, action.page) };
      }
      case "select-session": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        const session = (await this.dsh.listSessions(action.computerId, action.projectId)).find((item) => item.id === action.sessionId);
        if (session === undefined) return { answer: "Session is no longer available." };
        this.setSession(actorId, conversationId, selected, session.id);
        return { answer: "Session selected.", view: await this.rootMenu(actorId, conversationId) };
      }
      case "presets": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        return { answer: "Presets", view: await this.presetsMenu(actorId, conversationId, action.computerId, action.projectId, action.page) };
      }
      case "create-session": {
        if (selected.computerId !== action.computerId || selected.projectId !== action.projectId) return { answer: "Project selection changed." };
        const computer = (await this.dsh.listComputers()).find((item) => item.id === action.computerId && item.status === "online");
        if (computer === undefined) return { answer: "Computer is offline or missing." };
        const project = (await this.dsh.listProjects(action.computerId)).find((item) => item.id === action.projectId);
        if (project === undefined || project.status !== "online") return { answer: "Project is no longer available." };
        const preset = (await this.dsh.listAgentPresets()).find((item) => item.id === action.presetId);
        if (preset === undefined) return { answer: "Preset is no longer available." };
        const session = await this.dsh.createSession(action.computerId, action.projectId, preset.id);
        this.setSession(actorId, conversationId, selected, session.id);
        return { answer: "Session created.", view: await this.rootMenu(actorId, conversationId) };
      }
    }
  }

  private async rootMenu(actorId: string, conversationId: string): Promise<MenuView> {
    const selected = this.selection(actorId, conversationId);
    const status = selected.sessionId === undefined ? "not selected" : await this.dsh.status(selected.sessionId);
    const text = [
      "Current target",
      "Computer: " + (selected.computerId ?? "not selected"),
      "Project: " + (selected.projectId ?? "not selected"),
      "Session: " + (selected.sessionId ?? "not selected"),
      "Status: " + status
    ].join("\n");
    return { text, rows: [
      [this.issue(actorId, conversationId, "Computers", { type: "computers", page: 0 })],
      [this.issue(actorId, conversationId, "Projects", selected.computerId === undefined ? { type: "computers", page: 0 } : { type: "projects", computerId: selected.computerId, page: 0 })],
      [this.issue(actorId, conversationId, "Sessions", selected.computerId === undefined ? { type: "computers", page: 0 } : selected.projectId === undefined ? { type: "projects", computerId: selected.computerId, page: 0 } : { type: "sessions", computerId: selected.computerId, projectId: selected.projectId, page: 0 })],
      [this.issue(actorId, conversationId, "New session", selected.computerId === undefined ? { type: "computers", page: 0 } : selected.projectId === undefined ? { type: "projects", computerId: selected.computerId, page: 0 } : { type: "presets", computerId: selected.computerId, projectId: selected.projectId, page: 0 })],
      [this.issue(actorId, conversationId, "Refresh", { type: "root" })]
    ] };
  }

  private async computersMenu(actorId: string, conversationId: string, page: number): Promise<MenuView> {
    const selected = this.selection(actorId, conversationId);
    const values = paginate(await this.dsh.listComputers(), page, this.pageSize);
    const rows = values.items.map((item) => [this.issue(actorId, conversationId, (selected.computerId === item.id ? "* " : "") + compact(item.title, 40) + " (" + item.status + ")", { type: "select-computer", computerId: item.id })]);
    rows.push(this.navigation(actorId, conversationId, values.page, values.pages, (next) => ({ type: "computers", page: next })));
    rows.push([this.issue(actorId, conversationId, "Back", { type: "root" }), this.issue(actorId, conversationId, "Refresh", { type: "computers", page: values.page })]);
    return { text: "Select a computer (page " + String(values.page + 1) + "/" + String(values.pages) + ")", rows };
  }

  private async projectsEntry(actorId: string, conversationId: string): Promise<MenuView> {
    const selected = this.selection(actorId, conversationId);
    return selected.computerId === undefined ? this.computersMenu(actorId, conversationId, 0) : this.projectsMenu(actorId, conversationId, selected.computerId, 0);
  }

  private async projectsMenu(actorId: string, conversationId: string, computerId: string, page: number): Promise<MenuView> {
    const selected = this.selection(actorId, conversationId);
    const values = paginate(await this.dsh.listProjects(computerId), page, this.pageSize);
    const rows = values.items.map((item) => [this.issue(actorId, conversationId, (selected.projectId === item.id ? "* " : "") + compact(item.title, 40) + " (" + item.status + ")", { type: "select-project", computerId, projectId: item.id })]);
    rows.push(this.navigation(actorId, conversationId, values.page, values.pages, (next) => ({ type: "projects", computerId, page: next })));
    rows.push([this.issue(actorId, conversationId, "Back", { type: "computers", page: 0 }), this.issue(actorId, conversationId, "Refresh", { type: "projects", computerId, page: values.page })]);
    return { text: "Select a project (page " + String(values.page + 1) + "/" + String(values.pages) + ")", rows };
  }

  private async sessionsEntry(actorId: string, conversationId: string): Promise<MenuView> {
    const selected = this.selection(actorId, conversationId);
    if (selected.computerId === undefined) return this.computersMenu(actorId, conversationId, 0);
    if (selected.projectId === undefined) return this.projectsMenu(actorId, conversationId, selected.computerId, 0);
    return this.sessionsMenu(actorId, conversationId, selected.computerId, selected.projectId, 0);
  }

  private async sessionsMenu(actorId: string, conversationId: string, computerId: string, projectId: string, page: number): Promise<MenuView> {
    const selected = this.selection(actorId, conversationId);
    const values = paginate(await this.dsh.listSessions(computerId, projectId), page, this.pageSize);
    const rows = values.items.map((item) => [this.issue(actorId, conversationId, (selected.sessionId === item.id ? "* " : "") + compact(item.title, 40) + " (" + item.status + ")", { type: "select-session", computerId, projectId, sessionId: item.id })]);
    rows.push(this.navigation(actorId, conversationId, values.page, values.pages, (next) => ({ type: "sessions", computerId, projectId, page: next })));
    rows.push([this.issue(actorId, conversationId, "Back", { type: "projects", computerId, page: 0 }), this.issue(actorId, conversationId, "Refresh", { type: "sessions", computerId, projectId, page: values.page })]);
    return { text: "Select a session (page " + String(values.page + 1) + "/" + String(values.pages) + ")", rows };
  }

  private async presetsMenu(actorId: string, conversationId: string, computerId: string, projectId: string, page: number): Promise<MenuView> {
    const values = paginate(await this.dsh.listAgentPresets(), page, this.pageSize);
    const rows = values.items.map((item) => {
      const mark = item.isDefault ? "* " : "";
      return [this.issue(actorId, conversationId, mark + compact(item.title, 40), { type: "create-session", computerId, projectId, presetId: item.id })];
    });
    rows.push(this.navigation(actorId, conversationId, values.page, values.pages, (next) => ({ type: "presets", computerId, projectId, page: next })));
    rows.push([this.issue(actorId, conversationId, "Back", { type: "root" }), this.issue(actorId, conversationId, "Refresh", { type: "presets", computerId, projectId, page: values.page })]);
    const text = values.items.length === 0
      ? "No available Agent presets."
      : "Select an Agent preset (page " + String(values.page + 1) + "/" + String(values.pages) + ")";
    return { text, rows };
  }

  private navigation(actorId: string, conversationId: string, page: number, pages: number, action: (page: number) => MenuAction) {
    const row = [];
    if (page > 0) row.push(this.issue(actorId, conversationId, "Previous", action(page - 1)));
    if (page + 1 < pages) row.push(this.issue(actorId, conversationId, "Next", action(page + 1)));
    return row;
  }

  private async use(actorId: string, conversationId: string, args: readonly string[]): Promise<string> {
    const [kind, id] = args;
    const selected = this.selection(actorId, conversationId);
    if (kind === "computer" && id !== undefined) {
      if (!(await this.dsh.listComputers()).some((item) => item.id === id && item.status === "online")) return "Unknown computer.";
      selected.computerId = id; selected.projectId = undefined;
      this.setSession(actorId, conversationId, selected, undefined);
      return "Computer selected: " + id;
    }
    if (kind === "project" && id !== undefined) {
      if (selected.computerId === undefined) return "Select a computer first.";
      if (!(await this.dsh.listProjects(selected.computerId)).some((item) => item.id === id && item.status === "online")) return "Unknown project.";
      selected.projectId = id;
      this.setSession(actorId, conversationId, selected, undefined);
      return "Project selected: " + id;
    }
    if (kind === "session" && id !== undefined) {
      if (selected.computerId === undefined || selected.projectId === undefined) return "Select a computer and project first.";
      if (!(await this.dsh.listSessions(selected.computerId, selected.projectId)).some((item) => item.id === id)) return "Unknown session for the selected project.";
      this.setSession(actorId, conversationId, selected, id);
      return "Session selected: " + id;
    }
    return "Usage: /use computer <id>, /use project <id>, or /use session <id>.";
  }

  private async create(actorId: string, conversationId: string): Promise<ControlReply> {
    const selected = this.selection(actorId, conversationId);
    if (selected.computerId === undefined || selected.projectId === undefined) return "Select a computer and project first.";
    const project = (await this.dsh.listProjects(selected.computerId)).find((item) => item.id === selected.projectId);
    if (project === undefined || project.status !== "online") return "Project is no longer available.";
    return this.presetsMenu(actorId, conversationId, selected.computerId, selected.projectId, 0);
  }

  private async stop(actorId: string, conversationId: string): Promise<string> {
    const sessionId = this.selection(actorId, conversationId).sessionId;
    if (sessionId === undefined) return "No session selected.";
    return (await this.dsh.stop(sessionId)) ? "Stop requested; queued work was preserved." : "No live turn to stop.";
  }

  private async sendText(actorId: string, conversationId: string, text: string, onProgress?: ControlProgressListener): Promise<string | undefined> {
    const sessionId = this.selection(actorId, conversationId).sessionId;
    if (sessionId === undefined) return "Select a session from /menu.";
    const key = this.selectionKey(actorId, conversationId);
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

function commandOf(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const [rawCommand = ""] = text.split(/\s+/u);
  return rawCommand.split("@", 1)[0]?.toLowerCase();
}

function compositeKey(first: string, second: string): string {
  return keyPart(first) + "|" + keyPart(second);
}

function keyPart(value: string): string {
  return String(value.length) + ":" + value;
}

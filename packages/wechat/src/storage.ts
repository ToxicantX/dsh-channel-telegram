import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "./types.js";

export class MemoryStorage implements Storage {
  private readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async has(key: string): Promise<boolean> { return this.values.has(key); }
  async clear(): Promise<void> { this.values.clear(); }
}

export class FileStorage implements Storage {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.enqueue(async () => {
      try { return JSON.parse(await readFile(this.file(key), "utf8")) as T; }
      catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    });
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true });
      await writeFile(this.file(key), JSON.stringify(value), "utf8");
    });
  }

  delete(key: string): Promise<void> { return this.enqueue(() => rm(this.file(key), { force: true })); }
  has(key: string): Promise<boolean> { return this.get(key).then((value) => value !== undefined); }
  clear(): Promise<void> { return this.enqueue(() => rm(this.directory, { recursive: true, force: true })); }

  private file(key: string): string {
    if (!/^[a-z0-9_-]+$/u.test(key)) throw new Error(`Invalid WeChat storage key: ${key}`);
    return path.join(this.directory, key + ".json");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

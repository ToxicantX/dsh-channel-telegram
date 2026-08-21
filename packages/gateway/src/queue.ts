export class BoundedIdSet {
  private readonly values = new Map<string, true>();

  constructor(private readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
  }

  addIfNew(id: string): boolean {
    if (this.values.has(id)) return false;
    this.values.set(id, true);
    if (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    return true;
  }
}

export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

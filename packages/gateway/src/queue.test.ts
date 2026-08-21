import { describe, expect, it } from "vitest";
import { BoundedIdSet, KeyedSerialQueue } from "./queue.js";

describe("gateway reliability primitives", () => {
  it("bounds idempotency history", () => {
    const values = new BoundedIdSet(2);
    expect(values.addIfNew("a")).toBe(true);
    expect(values.addIfNew("a")).toBe(false);
    values.addIfNew("b"); values.addIfNew("c");
    expect(values.addIfNew("a")).toBe(true);
  });

  it("serializes the same session while allowing another key", async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run("s1", async () => { order.push("first:start"); await gate; order.push("first:end"); });
    const second = queue.run("s1", async () => { order.push("second"); });
    const other = queue.run("s2", async () => { order.push("other"); });
    await other;
    expect(order).toEqual(["first:start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "other", "first:end", "second"]);
  });
});

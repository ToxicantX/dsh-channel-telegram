import { describe, expect, it } from "vitest";
import { CallbackTokenStore, paginate } from "./menu.js";

describe("CallbackTokenStore", () => {
  it("binds opaque single-use callbacks to a user and chat", () => {
    const store = new CallbackTokenStore({ token: () => "opaque" });
    const data = store.issue(42, 10, { type: "root" });
    expect(store.consume(data, 7, 10)).toBeUndefined();
    expect(store.consume(data, 42, 11)).toBeUndefined();
    expect(store.consume(data, 42, 10)).toEqual({ type: "root" });
    expect(store.consume(data, 42, 10)).toBeUndefined();
  });

  it("expires callbacks and clamps pagination", () => {
    let now = 0;
    const store = new CallbackTokenStore({ ttlMs: 100, now: () => now, token: () => "opaque" });
    const data = store.issue(42, 10, { type: "root" });
    now = 100;
    expect(store.consume(data, 42, 10)).toBeUndefined();
    expect(paginate([1, 2, 3], 99, 2)).toEqual({ items: [3], page: 1, pages: 2 });
  });
});

import { describe, expect, it } from "vitest";
import { inject } from "./index.js";

describe("client dependencies", () => {
  it("waits for the credentials remote namespace", () => {
    expect(inject).toContain("remote.credentials");
  });
});

import { describe, expect, it } from "vitest";
import * as shared from "@pulse/shared";

describe("shared workspace package", () => {
  it("can be imported by its workspace name", () => {
    expect(shared).toBeDefined();
  });
});

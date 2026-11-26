import { describe, expect, it, vi } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
} from "./base64-polyfill.ts";

const sixtyFive = Uint8Array.from(
  { length: 65 },
  (_, i) => (i * 7 + 250) & 0xff,
);

const vectors: Record<string, Uint8Array> = {
  empty: new Uint8Array([]),
  zero: new Uint8Array([0x00]),
  ff: new Uint8Array([0xff]),
  onePad: new Uint8Array([1, 2, 3, 4]),
  twoPad: new Uint8Array([1, 2, 3, 4, 5]),
  noPad: new Uint8Array([1, 2, 3]),
  sixtyFive: sixtyFive,
};

describe("base64 helpers", () => {
  for (const [name, bytes] of Object.entries(vectors)) {
    it(`round-trips ${name}`, () => {
      for (const alphabet of ["base64", "base64url"] as const) {
        const text = bytesToBase64(bytes, alphabet);
        expect(Array.from(base64ToBytes(text, alphabet))).toEqual(
          Array.from(bytes),
        );
      }
    });
  }

  it("matches Node's Buffer encoding", () => {
    for (const bytes of Object.values(vectors)) {
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
      expect(bytesToBase64(bytes, "base64url")).toBe(
        Buffer.from(bytes).toString("base64url"),
      );
    }
  });

  it("decodes a known string", () => {
    expect(
      new TextDecoder().decode(base64ToBytes("SGVsbG8sIFB1bHNlIQ==")),
    ).toBe("Hello, Pulse!");
  });

  it("encodes base64url without padding using - and _", () => {
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), "base64url")).toBe(
      "-_8",
    );
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]), "base64")).toBe("+/8=");
  });

  it("decodes base64url with missing padding", () => {
    expect(Array.from(base64ToBytes("-_8", "base64url"))).toEqual([0xfb, 0xff]);
  });

  it("rejects invalid input", () => {
    expect(() => base64ToBytes("a")).toThrow(SyntaxError);
    expect(() => base64ToBytes("!!!!")).toThrow(SyntaxError);
  });
});

describe("hex helpers", () => {
  it("round-trips", () => {
    const bytes = new Uint8Array([0, 1, 0x7f, 0x80, 0xff]);
    expect(bytesToHex(bytes)).toBe("00017f80ff");
    expect(Array.from(hexToBytes("00017f80ff"))).toEqual(Array.from(bytes));
  });
});

describe("installed globals", () => {
  it("Uint8Array.fromBase64 and toBase64 honour the alphabet option", async () => {
    await import("./base64-polyfill.ts");
    const bytes = Uint8Array.fromBase64("-_8", { alphabet: "base64url" });
    expect(Array.from(bytes)).toEqual([0xfb, 0xff]);
    expect(bytes.toBase64({ alphabet: "base64url", omitPadding: true })).toBe(
      "-_8",
    );
    expect(bytes.toBase64({ alphabet: "base64url" })).toBe("-_8=");
    expect(bytes.toBase64()).toBe("+/8=");
    expect(Uint8Array.fromHex("00ff").toHex()).toBe("00ff");
  });

  it("installs the polyfill when native methods are missing, and keeps native ones", async () => {
    type Loose = Record<string, unknown>;
    const ctor = Uint8Array as unknown as Loose;
    const proto = Uint8Array.prototype as unknown as Loose;
    const saved = {
      fromBase64: ctor["fromBase64"],
      fromHex: ctor["fromHex"],
      toBase64: proto["toBase64"],
      toHex: proto["toHex"],
    };
    try {
      delete ctor["fromBase64"];
      delete ctor["fromHex"];
      delete proto["toBase64"];
      delete proto["toHex"];
      vi.resetModules();
      await import("./base64-polyfill.ts");
      const bytes = Uint8Array.fromBase64("-_8", { alphabet: "base64url" });
      expect(Array.from(bytes)).toEqual([0xfb, 0xff]);
      expect(bytes.toBase64({ alphabet: "base64url", omitPadding: true })).toBe(
        "-_8",
      );
      expect(bytes.toBase64({ alphabet: "base64url" })).toBe("-_8=");
      expect(bytes.toHex()).toBe("fbff");
      // Idempotent guard: a second import must not replace what is installed.
      const installed = ctor["fromBase64"];
      vi.resetModules();
      await import("./base64-polyfill.ts");
      expect(ctor["fromBase64"]).toBe(installed);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        const target = k.startsWith("from") ? ctor : proto;
        if (v === undefined) delete target[k];
        else target[k] = v;
      }
    }
  });
});

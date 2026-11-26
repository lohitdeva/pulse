// Polyfill for the TC39 Uint8Array base64/hex methods. The Supabase Edge
// Runtime (Deno 2.1.4) lacks them, but jsr:@daaku/webpush uses them.
// Importing this module installs them only if absent (native wins).

export type Base64Alphabet = "base64" | "base64url";

export interface Base64Options {
  alphabet?: Base64Alphabet;
  omitPadding?: boolean;
}

declare global {
  interface Uint8ArrayConstructor {
    fromBase64(string: string, options?: Base64Options): Uint8Array;
    fromHex(string: string): Uint8Array;
  }
  interface Uint8Array {
    toBase64(options?: Base64Options): string;
    toHex(): string;
  }
}

const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const LOOKUP: Record<string, number> = {};
for (let i = 0; i < STD.length; i++) LOOKUP[STD.charAt(i)] = i;

export function base64ToBytes(
  s: string,
  alphabet: Base64Alphabet = "base64",
): Uint8Array {
  let str = s.replace(/[\t\n\f\r ]+/g, "");
  if (alphabet === "base64url") str = str.replace(/-/g, "+").replace(/_/g, "/");
  str = str.replace(/=+$/, "");
  if (str.length % 4 === 1) throw new SyntaxError("Invalid base64 length");
  const out = new Uint8Array(Math.floor((str.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < str.length; i += 4) {
    let acc = 0;
    const n = Math.min(4, str.length - i);
    for (let j = 0; j < 4; j++) {
      let v = 0;
      if (j < n) {
        const c = LOOKUP[str.charAt(i + j)];
        if (c === undefined) throw new SyntaxError("Invalid base64 character");
        v = c;
      }
      acc = (acc << 6) | v;
    }
    if (o < out.length) out[o++] = (acc >> 16) & 0xff;
    if (o < out.length) out[o++] = (acc >> 8) & 0xff;
    if (o < out.length) out[o++] = acc & 0xff;
  }
  return out;
}

export function bytesToBase64(
  b: Uint8Array,
  alphabet: Base64Alphabet = "base64",
): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const b0 = b[i] ?? 0;
    const b1 = b[i + 1] ?? 0;
    const b2 = b[i + 2] ?? 0;
    const acc = (b0 << 16) | (b1 << 8) | b2;
    const remaining = b.length - i;
    out += STD.charAt((acc >> 18) & 63) + STD.charAt((acc >> 12) & 63);
    out += remaining > 1 ? STD.charAt((acc >> 6) & 63) : "=";
    out += remaining > 2 ? STD.charAt(acc & 63) : "=";
  }
  if (alphabet === "base64url") {
    return out.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  return out;
}

export function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    throw new SyntaxError("Invalid hex string");
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (const v of b) out += v.toString(16).padStart(2, "0");
  return out;
}

function define(target: object, name: string, value: unknown): void {
  if (name in target) return; // never override native support
  Object.defineProperty(target, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

define(
  Uint8Array,
  "fromBase64",
  function fromBase64(string: string, options?: Base64Options): Uint8Array {
    return base64ToBytes(string, options?.alphabet ?? "base64");
  },
);
define(
  Uint8Array.prototype,
  "toBase64",
  function toBase64(this: Uint8Array, options?: Base64Options): string {
    // Per the TC39 spec, padding is kept (even for base64url) unless
    // omitPadding is set.
    let s = bytesToBase64(this, "base64");
    if (options?.alphabet === "base64url") {
      s = s.replace(/\+/g, "-").replace(/\//g, "_");
    }
    return options?.omitPadding ? s.replace(/=+$/, "") : s;
  },
);
define(Uint8Array, "fromHex", function fromHex(string: string): Uint8Array {
  return hexToBytes(string);
});
define(Uint8Array.prototype, "toHex", function toHex(this: Uint8Array): string {
  return bytesToHex(this);
});

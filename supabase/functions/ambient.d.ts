// Minimal ambient types for the Node-only APIs the Vitest tests use
// (no @types/node in the workspace).
declare const Buffer: {
  from(data: Uint8Array): {
    toString(encoding: "base64" | "base64url" | "hex"): string;
  };
};

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, readFile, lstat, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(repoRoot, ".env.local");

function assertIgnoredEnvFile() {
  try {
    execFileSync("git", ["check-ignore", "--quiet", ".env.local"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      "Refusing to write VAPID keys because .env.local is not ignored",
    );
  }
}

function valuesFor(text, name) {
  const matches = text.match(new RegExp(`^${name}=(.*)$`, "gm")) ?? [];
  if (matches.length > 1)
    throw new Error(`Duplicate ${name} entries in .env.local`);
  if (matches.length === 0) return undefined;

  const value = matches[0].slice(name.length + 1);
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function matchesPair(publicValue, privateValue) {
  try {
    const jwk = JSON.parse(privateValue);
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) {
      return false;
    }
    const derived = createPublicKey(
      createPrivateKey({ key: jwk, format: "jwk" }),
    ).export({ format: "jwk" });
    const uncompressedPoint = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(derived.x, "base64url"),
      Buffer.from(derived.y, "base64url"),
    ]);
    return base64Url(uncompressedPoint) === publicValue;
  } catch {
    return false;
  }
}

async function readEnvFile() {
  try {
    const metadata = await lstat(envPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(
        "Refusing to write VAPID keys to a non-regular .env.local file",
      );
    }
    const text = await readFile(envPath, "utf8");
    return { text, exists: true };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: "", exists: false };
    throw error;
  }
}

async function writeKeys(publicKey, privateKey) {
  const { text, exists } = await readEnvFile();
  const previousPublic = valuesFor(text, "VAPID_PUBLIC_KEY");
  const previousPrivate = valuesFor(text, "VAPID_PRIVATE_KEY");
  const previousFrontendPublic = valuesFor(text, "VITE_VAPID_PUBLIC_KEY");

  if (previousPublic !== undefined && previousPrivate !== undefined) {
    if (!matchesPair(previousPublic, previousPrivate)) {
      throw new Error(
        "Existing VAPID keypair is inconsistent; .env.local was left unchanged",
      );
    }
    if (
      previousFrontendPublic !== undefined &&
      previousFrontendPublic !== previousPublic
    ) {
      throw new Error(
        "Existing frontend VAPID key differs; .env.local was left unchanged",
      );
    }
    if (previousFrontendPublic !== undefined) return "unchanged";

    const file = await open(envPath, "a", 0o600);
    try {
      const newline = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
      await file.writeFile(
        `${newline}VITE_VAPID_PUBLIC_KEY=${previousPublic}\n`,
        "utf8",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(envPath, 0o600);
    return "frontend-key-added";
  }
  if (previousPublic !== undefined || previousPrivate !== undefined) {
    throw new Error(
      "Existing VAPID keypair is incomplete; .env.local was left unchanged",
    );
  }
  if (previousFrontendPublic !== undefined) {
    throw new Error(
      "Existing frontend VAPID key has no server keypair; .env.local was left unchanged",
    );
  }

  const newline = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  const addition = `${newline}VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY='${privateKey}'\nVITE_VAPID_PUBLIC_KEY=${publicKey}\n`;
  if (exists) await chmod(envPath, 0o600);
  const file = await open(envPath, "a", 0o600);
  try {
    await file.writeFile(addition, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(envPath, 0o600);
  return "created";
}

assertIgnoredEnvFile();
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const exported = privateKey.export({ format: "jwk" });
const privateJwk = {
  kty: "EC",
  crv: "P-256",
  x: exported.x,
  y: exported.y,
  d: exported.d,
};
const rawPublicPoint = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(exported.x, "base64url"),
  Buffer.from(exported.y, "base64url"),
]);
const result = await writeKeys(
  base64Url(rawPublicPoint),
  JSON.stringify(privateJwk),
);
process.stdout.write(
  result === "created"
    ? "Generated VAPID server and frontend keys in ignored .env.local.\n"
    : result === "frontend-key-added"
      ? "Added VITE_VAPID_PUBLIC_KEY for the existing keypair; keys unchanged.\n"
      : "A valid VAPID keypair and frontend key already exist in ignored .env.local; unchanged.\n",
);

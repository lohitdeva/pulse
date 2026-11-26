/**
 * Reminder notification actions (T3.3).
 *
 * Authentication: dispatch-reminders signs a stateless token per reminder push
 * (HMAC-SHA256 keyed from the project's service-role key, bound to user, day and
 * item, with an expiry). The token travels only inside the encrypted push payload
 * and the HTTPS request body, never in a URL or a log. No migration is needed.
 *
 * All I/O goes through the injected store, so the Vitest tests run on fakes.
 */

export type ReminderAction = "done" | "snooze" | "skip" | "attended" | "missed";

const REMINDER_ACTIONS = new Set<string>([
  "done",
  "snooze",
  "skip",
  "attended",
  "missed",
]);
const ATTENDANCE_SUFFIX = ":attendance";
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_KEY = /^[A-Za-z0-9:_-]{1,120}$/;
const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SNOOZE_MS = 10 * 60 * 1000;
const SKIP_REASON = "from notification";
const ATTENDANCE_STATUS = {
  attended: "done",
  missed: "missed",
} as const;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: Record<string, unknown>, status: number): Response =>
  Response.json(body, { status, headers: { ...cors, "Cache-Control": "no-store" } });

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const HKDF_INFO = "pulse-notification-action-v1";

/** HKDF-SHA256 from the service-role key with a fixed info label, no salt. */
async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    [usage],
  );
}

const signedMessage = (
  userId: string,
  dayKey: string,
  itemKey: string,
  expiresAtMs: number,
): Uint8Array<ArrayBuffer> => {
  const text = new TextEncoder().encode(`${userId}|${dayKey}|${itemKey}|${expiresAtMs}`);
  const bytes = new Uint8Array(new ArrayBuffer(text.length));
  bytes.set(text);
  return bytes;
};

/** Token format: `<userId>.<expiresAtMs>.<base64url HMAC>`. */
export async function signActionToken(
  secret: string,
  userId: string,
  dayKey: string,
  itemKey: string,
  now: Date,
): Promise<string> {
  const expiresAtMs = now.getTime() + TOKEN_TTL_MS;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    signedMessage(userId, dayKey, itemKey, expiresAtMs),
  );
  return `${userId}.${expiresAtMs}.${base64Url(new Uint8Array(signature))}`;
}

/** Returns the user id the token was issued for, or null when invalid or expired. */
export async function verifyActionToken(
  secret: string,
  token: string,
  dayKey: string,
  itemKey: string,
  now: Date,
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, signature] = parts as [string, string, string];
  if (!USER_ID.test(userId) || !/^\d{1,15}$/.test(expires)) return null;
  const expiresAtMs = Number(expires);
  if (!(expiresAtMs > now.getTime())) return null;
  const signatureBytes = fromBase64Url(signature);
  if (!signatureBytes) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signatureBytes,
    signedMessage(userId, dayKey, itemKey, expiresAtMs),
  );
  return valid ? userId : null;
}

export interface StoredReminder {
  kind: string;
  resolution: string | null;
  snoozed_until: string | null;
}

export interface ReminderActionStore {
  getReminder(
    userId: string,
    dayKey: string,
    itemKey: string,
  ): Promise<StoredReminder | null>;
  /** Update only while resolution is still null. */
  resolveReminder(
    userId: string,
    dayKey: string,
    itemKey: string,
    patch: { resolution: "done" | "skipped"; resolution_reason: string | null; resolved_at: string },
  ): Promise<void>;
  /** Update only while resolution is still null. */
  snoozeReminder(
    userId: string,
    dayKey: string,
    itemKey: string,
    snoozedUntil: string,
  ): Promise<void>;
  /** `overwrite: false` keeps an existing log (insert ... on conflict do nothing). */
  upsertItemLog(
    row: {
      user_id: string;
      day_key: string;
      item_key: string;
      status: "done" | "skipped" | "missed";
      logged_at: string;
      meta: Record<string, unknown>;
    },
    overwrite: boolean,
  ): Promise<void>;
}

export interface ReminderActionDependencies {
  secret: string | undefined;
  store: ReminderActionStore;
  now?: () => Date;
}

/** True when the body is a reminder action (as opposed to the Phase 0 test push). */
export function isReminderActionBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "actionToken" in body
  );
}

export async function handleReminderActionRequest(
  request: Request,
  deps: ReminderActionDependencies,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!deps.secret) return json({ error: "Action callback is unavailable" }, 503);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Invalid request" }, 400);
  }
  const input = body as Record<string, unknown>;
  const { actionToken, itemKey, dayKey, action } = input;
  if (
    typeof actionToken !== "string" ||
    typeof itemKey !== "string" ||
    !ITEM_KEY.test(itemKey) ||
    typeof dayKey !== "string" ||
    !DAY_KEY.test(dayKey) ||
    typeof action !== "string" ||
    !REMINDER_ACTIONS.has(action)
  ) {
    return json({ error: "Invalid request" }, 400);
  }

  const now = (deps.now ?? (() => new Date()))();
  const userId = await verifyActionToken(
    deps.secret,
    actionToken,
    dayKey,
    itemKey,
    now,
  ).catch(() => null);
  if (!userId) return json({ error: "Invalid or expired action" }, 401);

  const isAttendanceItem = itemKey.endsWith(ATTENDANCE_SUFFIX);
  const isAttendanceAction = action === "attended" || action === "missed";
  if (isAttendanceItem !== isAttendanceAction || itemKey.startsWith("alert:")) {
    return json({ error: "Invalid request" }, 400);
  }

  const act = action as ReminderAction;
  const nowIso = now.toISOString();
  try {
    const reminder = await deps.store.getReminder(userId, dayKey, itemKey);
    if (!reminder) return json({ error: "Invalid or expired action" }, 404);
    const alreadyResolved = reminder.resolution !== null;

    if (isAttendanceAction) {
      const attendance = act as "attended" | "missed";
      const classKey = itemKey.slice(0, -ATTENDANCE_SUFFIX.length);
      await deps.store.upsertItemLog(
        {
          user_id: userId,
          day_key: dayKey,
          item_key: classKey,
          status: ATTENDANCE_STATUS[attendance],
          logged_at: nowIso,
          meta: { attendance },
        },
        // Never overwrite: a repeated tap must not clobber a later in-app correction.
        false,
      );
      await deps.store.resolveReminder(userId, dayKey, itemKey, {
        resolution: "done",
        resolution_reason: null,
        resolved_at: nowIso,
      });
      return json({ ok: true, action: act, idempotent: alreadyResolved }, 200);
    }

    if (act === "snooze") {
      if (reminder.resolution) {
        return json({ ok: true, action: act, idempotent: true }, 200);
      }
      const current = reminder.snoozed_until ? Date.parse(reminder.snoozed_until) : NaN;
      if (current > now.getTime()) {
        return json({ ok: true, action: act, idempotent: true }, 200);
      }
      await deps.store.snoozeReminder(
        userId,
        dayKey,
        itemKey,
        new Date(now.getTime() + SNOOZE_MS).toISOString(),
      );
      return json({ ok: true, action: act, idempotent: false }, 200);
    }

    // done | skip
    const resolution = act === "done" ? "done" : "skipped";
    if (reminder.resolution && reminder.resolution !== resolution) {
      return json({ error: "Notification already handled" }, 409);
    }
    // Meals: reminders only. The app logs the meal (with its place) later, so no
    // fake item log is written. Classes are logged through attendance only.
    const logsItem = reminder.kind !== "meal" && reminder.kind !== "class";
    if (logsItem) {
      await deps.store.upsertItemLog(
        {
          user_id: userId,
          day_key: dayKey,
          item_key: itemKey,
          status: resolution,
          logged_at: nowIso,
          meta: { source: "notification" },
        },
        false,
      );
    }
    if (!reminder.resolution) {
      await deps.store.resolveReminder(userId, dayKey, itemKey, {
        resolution,
        resolution_reason: act === "skip" ? SKIP_REASON : null,
        resolved_at: nowIso,
      });
    }
    return json({ ok: true, action: act, idempotent: alreadyResolved }, 200);
  } catch {
    // Never log the request, token or item data.
    return json({ error: "Unable to save notification action" }, 503);
  }
}

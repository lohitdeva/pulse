import { describe, expect, it } from "vitest";
import {
  handleReminderActionRequest,
  isReminderActionBody,
  signActionToken,
  verifyActionToken,
  type ReminderActionStore,
  type StoredReminder,
} from "./handler";

const SECRET = "service-role-key-for-tests-only";
const USER = "00000000-0000-4000-8000-000000000001";
const DAY = "2026-11-26";
const NOW = new Date("2026-11-26T06:00:00.000Z");

interface Harness {
  call(body: Record<string, unknown>, opts?: { now?: Date; secret?: string | undefined }): Promise<Response>;
  token(itemKey: string, dayKey?: string): Promise<string>;
  reminders: Map<string, StoredReminder & { reason?: string | null }>;
  logs: Map<string, { status: string; meta: Record<string, unknown> }>;
  writes: number;
}

function harness(initial: Record<string, StoredReminder>): Harness {
  const reminders = new Map<string, StoredReminder & { reason?: string | null }>(
    Object.entries(initial),
  );
  const logs = new Map<string, { status: string; meta: Record<string, unknown> }>();
  const h: Harness = { reminders, logs, writes: 0 } as Harness;
  const store: ReminderActionStore = {
    async getReminder(_u, _d, itemKey) {
      return reminders.get(itemKey) ?? null;
    },
    async resolveReminder(_u, _d, itemKey, patch) {
      const row = reminders.get(itemKey);
      if (row && row.resolution === null) {
        row.resolution = patch.resolution;
        row.reason = patch.resolution_reason;
        h.writes += 1;
      }
    },
    async snoozeReminder(_u, _d, itemKey, until) {
      const row = reminders.get(itemKey);
      if (row && row.resolution === null) {
        row.snoozed_until = until;
        h.writes += 1;
      }
    },
    async upsertItemLog(row, overwrite) {
      if (overwrite || !logs.has(row.item_key)) {
        logs.set(row.item_key, { status: row.status, meta: row.meta });
      }
    },
  };
  h.token = (itemKey, dayKey = DAY) => signActionToken(SECRET, USER, dayKey, itemKey, NOW);
  h.call = (body, opts = {}) =>
    handleReminderActionRequest(
      new Request("https://pulse.example/functions/v1/notification-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      {
        secret: "secret" in opts ? opts.secret : SECRET,
        store,
        now: () => opts.now ?? NOW,
      },
    );
  return h;
}

const row = (kind: string, resolution: string | null = null): StoredReminder => ({
  kind,
  resolution,
  snoozed_until: null,
});

async function act(h: Harness, itemKey: string, action: string) {
  return h.call({
    actionToken: await h.token(itemKey),
    itemKey,
    dayKey: DAY,
    action,
  });
}

describe("action tokens", () => {
  it("round-trips for the same user, day and item only", async () => {
    const token = await signActionToken(SECRET, USER, DAY, "must:1", NOW);
    expect(await verifyActionToken(SECRET, token, DAY, "must:1", NOW)).toBe(USER);
    expect(await verifyActionToken(SECRET, token, DAY, "must:2", NOW)).toBeNull();
    expect(await verifyActionToken(SECRET, token, "2026-11-27", "must:1", NOW)).toBeNull();
    expect(await verifyActionToken("other-secret", token, DAY, "must:1", NOW)).toBeNull();
  });

  it("expires and rejects tampering", async () => {
    const token = await signActionToken(SECRET, USER, DAY, "must:1", NOW);
    const later = new Date(NOW.getTime() + 13 * 60 * 60 * 1000);
    expect(await verifyActionToken(SECRET, token, DAY, "must:1", later)).toBeNull();
    const [user, , sig] = token.split(".");
    const extended = `${user}.${NOW.getTime() + 999_999_999_999}.${sig}`;
    expect(await verifyActionToken(SECRET, extended, DAY, "must:1", NOW)).toBeNull();
    expect(await verifyActionToken(SECRET, "garbage", DAY, "must:1", NOW)).toBeNull();
    expect(await verifyActionToken(SECRET, `${user}.${NOW.getTime()}.!!`, DAY, "must:1", NOW)).toBeNull();
  });
});

describe("reminder actions", () => {
  it("recognises reminder bodies by the token field", () => {
    expect(isReminderActionBody({ actionToken: "x" })).toBe(true);
    expect(isReminderActionBody({ notificationId: "x", capability: "y" })).toBe(false);
    expect(isReminderActionBody(null)).toBe(false);
  });

  it("Done resolves the reminder and logs the item", async () => {
    const h = harness({ "must:2026-11-26:4": row("gym") });
    const res = await act(h, "must:2026-11-26:4", "done");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "done", idempotent: false });
    expect(h.reminders.get("must:2026-11-26:4")?.resolution).toBe("done");
    expect(h.logs.get("must:2026-11-26:4")).toEqual({
      status: "done",
      meta: { source: "notification" },
    });
  });

  it("Done on a meal resolves the reminder only (the app logs the meal later)", async () => {
    const h = harness({ "must:2026-11-26:2": row("meal") });
    expect((await act(h, "must:2026-11-26:2", "done")).status).toBe(200);
    expect(h.reminders.get("must:2026-11-26:2")?.resolution).toBe("done");
    expect(h.logs.size).toBe(0);
  });

  it("Snooze sets snoozed_until to now + 10 minutes and nothing else", async () => {
    const h = harness({ "must:2026-11-26:4": row("gym") });
    const res = await act(h, "must:2026-11-26:4", "snooze");
    expect(res.status).toBe(200);
    const stored = h.reminders.get("must:2026-11-26:4")!;
    expect(stored.snoozed_until).toBe("2026-11-26T06:10:00.000Z");
    expect(stored.resolution).toBeNull();
    expect(h.logs.size).toBe(0);
  });

  it("Skip resolves as skipped with the notification reason and logs it", async () => {
    const h = harness({ "habit:2026-11-26:2": row("nudge") });
    expect((await act(h, "habit:2026-11-26:2", "skip")).status).toBe(200);
    const stored = h.reminders.get("habit:2026-11-26:2")!;
    expect(stored.resolution).toBe("skipped");
    expect(stored.reason).toBe("from notification");
    expect(h.logs.get("habit:2026-11-26:2")?.status).toBe("skipped");
  });

  it.each([
    ["attended", "done"],
    ["missed", "missed"],
  ])("%s writes class attendance like the app", async (action, status) => {
    const key = "class:11111111-1111-4111-8111-111111111111:attendance";
    const h = harness({ [key]: row("class") });
    expect((await act(h, key, action)).status).toBe(200);
    expect(h.logs.get("class:11111111-1111-4111-8111-111111111111")).toEqual({
      status,
      meta: { attendance: action },
    });
    expect(h.reminders.get(key)?.resolution).toBe("done");
  });

  it("a repeated attendance tap never overwrites an existing class log", async () => {
    const key = "class:11111111-1111-4111-8111-111111111111:attendance";
    const logKey = "class:11111111-1111-4111-8111-111111111111";
    const h = harness({ [key]: row("class") });
    expect((await act(h, key, "attended")).status).toBe(200);
    h.logs.set(logKey, { status: "missed", meta: { source: "app-correction" } });
    const again = await act(h, key, "attended");
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ idempotent: true });
    expect(h.logs.get(logKey)).toEqual({
      status: "missed",
      meta: { source: "app-correction" },
    });
  });

  it("derives a different token key per secret (HKDF) and verifies its own", async () => {
    const good = await signActionToken(SECRET, USER, DAY, "must:1", NOW);
    expect(await verifyActionToken(SECRET, good, DAY, "must:1", NOW)).toBe(USER);
    expect(await verifyActionToken("other-secret", good, DAY, "must:1", NOW)).toBeNull();
  });

  it("is idempotent: a repeated action changes nothing and still succeeds", async () => {
    const h = harness({ "must:2026-11-26:4": row("gym") });
    await act(h, "must:2026-11-26:4", "done");
    const writes = h.writes;
    const again = await act(h, "must:2026-11-26:4", "done");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, action: "done", idempotent: true });
    expect(h.writes).toBe(writes);

    await act(h, "must:2026-11-26:4", "snooze");
    expect(h.writes).toBe(writes);

    const conflict = await act(h, "must:2026-11-26:4", "skip");
    expect(conflict.status).toBe(409);

    const g = harness({ "must:2026-11-26:5": row("gym") });
    await act(g, "must:2026-11-26:5", "snooze");
    const snoozedAt = g.reminders.get("must:2026-11-26:5")!.snoozed_until;
    await act(g, "must:2026-11-26:5", "snooze");
    expect(g.writes).toBe(1);
    expect(g.reminders.get("must:2026-11-26:5")!.snoozed_until).toBe(snoozedAt);
  });

  it("rejects a bad, expired or mismatched token with a generic 401 and writes nothing", async () => {
    const h = harness({ "must:2026-11-26:4": row("gym") });
    const good = await h.token("must:2026-11-26:4");
    const cases = [
      { actionToken: "nope" },
      { actionToken: good.replace(/.$/, (c) => (c === "A" ? "B" : "A")) },
      { actionToken: await h.token("must:2026-11-26:9") },
      { actionToken: good, dayKey: "2026-11-27" },
    ];
    for (const override of cases) {
      const res = await h.call({
        actionToken: good,
        itemKey: "must:2026-11-26:4",
        dayKey: DAY,
        action: "done",
        ...override,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid or expired action" });
    }
    const expired = await h.call(
      { actionToken: good, itemKey: "must:2026-11-26:4", dayKey: DAY, action: "done" },
      { now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) },
    );
    expect(expired.status).toBe(401);
    expect(h.writes).toBe(0);
    expect(h.logs.size).toBe(0);
  });

  it("rejects malformed bodies, mismatched action kinds and a missing secret", async () => {
    const attKey = "class:11111111-1111-4111-8111-111111111111:attendance";
    const h = harness({ "must:2026-11-26:4": row("gym"), [attKey]: row("class") });
    expect((await h.call({ actionToken: "x", itemKey: "must:1", dayKey: DAY })).status).toBe(400);
    expect((await act(h, "must:2026-11-26:4", "attended")).status).toBe(400);
    expect((await act(h, attKey, "done")).status).toBe(400);
    expect(
      (await h.call({ actionToken: "x", itemKey: "a b", dayKey: DAY, action: "done" })).status,
    ).toBe(400);
    const noSecret = await h.call(
      { actionToken: "x", itemKey: "must:1", dayKey: DAY, action: "done" },
      { secret: undefined },
    );
    expect(noSecret.status).toBe(503);
    const get = await handleReminderActionRequest(
      new Request("https://pulse.example/", { method: "GET" }),
      { secret: SECRET, store: {} as ReminderActionStore },
    );
    expect(get.status).toBe(405);
  });

  it("returns 404 for an unknown reminder and a generic 503 on store failure", async () => {
    const h = harness({});
    expect((await act(h, "must:2026-11-26:4", "done")).status).toBe(404);

    const failing: ReminderActionStore = {
      async getReminder() {
        throw new Error("secret detail");
      },
      async resolveReminder() {},
      async snoozeReminder() {},
      async upsertItemLog() {},
    };
    const res = await handleReminderActionRequest(
      new Request("https://pulse.example/", {
        method: "POST",
        body: JSON.stringify({
          actionToken: await signActionToken(SECRET, USER, DAY, "must:1", NOW),
          itemKey: "must:1",
          dayKey: DAY,
          action: "done",
        }),
      }),
      { secret: SECRET, store: failing, now: () => NOW },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Unable to save notification action" });
  });
});

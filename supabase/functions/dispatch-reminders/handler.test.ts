import { describe, expect, it, vi } from "vitest";
import { istDateTimeLocalToUtc } from "../../../shared/time";
import { verifyActionToken } from "../notification-action/handler";
import {
  createDispatchRemindersHandler,
  type AlertRow,
  type ClassRow,
  type DayData,
  type DispatchStore,
  type ItemLogRow,
  type PushPayload,
  type ReminderRow,
  type ReminderUpsert,
  type SendPush,
  type SubscriptionRow,
} from "./handler";

const SECRET = "dispatch-secret-for-tests-only";
const SERVICE_KEY = "service-role-key-for-tests-only";
const OWNER = "00000000-0000-4000-8000-000000000001";
const DAY = "2026-11-26"; // Thursday: weekday template
const at = (hhmm: string) => new Date(istDateTimeLocalToUtc(`${DAY}T${hhmm}`));

const sub = (id: string): SubscriptionRow => ({
  id,
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  p256dh: "p",
  auth: "a",
});

function classRow(id: string, start: string, end: string): ClassRow {
  return {
    id,
    kind: "class",
    source_starts_at: at(start).toISOString(),
    source_ends_at: at(end).toISOString(),
    source_title: "OM-I-2",
    source_course: "OM-I",
    source_session: 2,
    source_professor: null,
    source_room: null,
    source_present: true,
    manual_state: "none",
    manual_starts_at: null,
    manual_ends_at: null,
    manual_title: null,
  };
}

interface Setup {
  now: Date;
  classes?: ClassRow[];
  mealLogs?: string[];
  itemLogs?: ItemLogRow[];
  subscriptions?: SubscriptionRow[];
  alerts?: AlertRow[];
  pushStatus?: number;
}

function setup(opts: Setup) {
  const clock = { now: opts.now };
  const reminders = new Map<string, ReminderRow>();
  const upserts: ReminderUpsert[] = [];
  const missed: { item_key: string; day_key: string }[] = [];
  const logs: { status: string; item_key: string }[] = [];
  const deleted: string[] = [];
  const delivered: string[] = [];
  let pending = [...(opts.alerts ?? [])];
  let subscriptions = opts.subscriptions ?? [sub("sub-1")];

  const store: DispatchStore = {
    checkSecret: async (candidate) => candidate === SECRET,
    loadDay: async (): Promise<DayData> => ({
      classes: opts.classes ?? [],
      reminders: [...reminders.values()],
      itemLogs: opts.itemLogs ?? [],
      mealLogs: (opts.mealLogs ?? []).map((meal) => ({ meal })),
      waterLogs: [],
      facilityHours: null,
      subscriptions,
    }),
    upsertReminder: async (row) => {
      upserts.push(row);
      const prev = reminders.get(row.item_key);
      reminders.set(row.item_key, {
        item_key: row.item_key,
        sent_count: row.sent_count ?? prev?.sent_count ?? 0,
        last_sent_at: row.last_sent_at ?? prev?.last_sent_at ?? null,
        snoozed_until: prev?.snoozed_until ?? null,
        resolution: row.resolution ?? prev?.resolution ?? null,
      });
    },
    insertNotificationLog: async (row) => {
      logs.push({ status: row.status, item_key: row.item_key });
    },
    insertMissed: async (row) => {
      // on conflict do nothing
      if (!missed.some((m) => m.item_key === row.item_key && m.day_key === row.day_key)) {
        missed.push({ item_key: row.item_key, day_key: row.day_key });
      }
    },
    deleteSubscription: async (_owner, id) => {
      deleted.push(id);
      subscriptions = subscriptions.filter((s) => s.id !== id);
    },
    pendingAlerts: async (_owner, limit) => pending.slice(0, limit),
    markAlertDelivered: async (_owner, id) => {
      delivered.push(id);
      pending = pending.filter((a) => a.id !== id);
    },
  };

  const pushed: PushPayload[] = [];
  const push: SendPush = vi.fn(async (_sub, payload) => {
    pushed.push(payload);
    return opts.pushStatus ?? 201;
  });

  const handler = createDispatchRemindersHandler({
    readEnv: (name) =>
      name === "COLLEGE_TIMETABLE_OWNER_ID"
        ? OWNER
        : name === "SUPABASE_SERVICE_ROLE_KEY"
          ? SERVICE_KEY
          : undefined,
    store,
    push,
    now: () => clock.now,
  });
  const call = (secret = SECRET) =>
    handler(
      new Request("https://pulse.example/functions/v1/dispatch-reminders", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
  return { call, clock, push, pushed, upserts, missed, logs, deleted, delivered };
}

describe("dispatch-reminders", () => {
  it("rejects a bad secret with a generic 401 and does nothing", async () => {
    const t = setup({ now: at("13:00") });
    const res = await t.call("wrong-secret");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(t.push).not.toHaveBeenCalled();
    expect(t.upserts).toHaveLength(0);
  });

  it("sends one push when lunch is due and records its state", async () => {
    const t = setup({ now: at("13:00") });
    const res = await t.call();
    expect(res.status).toBe(200);
    expect(t.pushed).toHaveLength(1);
    const payload = t.pushed[0]!;
    expect(payload.title).toBe("Lunch");
    expect(payload.tag).toBe(payload.data.itemKey);
    expect(payload.data.dayKey).toBe(DAY);
    expect(payload.data.url).toBe(`/?focus=${encodeURIComponent(payload.data.itemKey)}`);
    expect(payload.actions.map((a) => a.action)).toEqual(["done", "snooze"]);
    const lunch = t.upserts.find((u) => u.item_key === payload.data.itemKey)!;
    expect(lunch).toMatchObject({ sent_count: 1, kind: "meal", level: "must" });
    expect(lunch.last_sent_at).toBe(at("13:00").toISOString());
    expect(t.logs).toEqual([{ status: "sent", item_key: payload.data.itemKey }]);
  });

  it("signs an action token bound to the owner, day and item", async () => {
    const t = setup({ now: at("13:00") });
    await t.call();
    const { data } = t.pushed[0]!;
    expect(typeof data.actionToken).toBe("string");
    expect(
      await verifyActionToken(SERVICE_KEY, data.actionToken!, DAY, data.itemKey, at("13:00")),
    ).toBe(OWNER);
    expect(
      await verifyActionToken(SERVICE_KEY, data.actionToken!, DAY, "must:other", at("13:00")),
    ).toBeNull();
  });

  it("does not push again when called twice in the same minute", async () => {
    const t = setup({ now: at("13:00") });
    await t.call();
    const res = await t.call();
    expect(t.pushed).toHaveLength(1);
    expect(await res.json()).toMatchObject({ sent: 0, missed: 0 });
  });

  it("logs a closed window as Missed exactly once", async () => {
    const t = setup({ now: at("15:00"), mealLogs: ["breakfast"] });
    await t.call();
    const lunchMissed = t.missed.filter((m) => m.item_key.startsWith("must:") && m.day_key === DAY);
    expect(lunchMissed).toHaveLength(1);
    expect(
      t.upserts.find((u) => u.item_key === lunchMissed[0]!.item_key)?.resolution,
    ).toBe("missed");
    t.clock.now = at("15:01");
    const again = await (await t.call()).json();
    expect(again).toMatchObject({ missed: 0 });
    expect(t.missed.filter((m) => m.item_key === lunchMissed[0]!.item_key)).toHaveLength(1);
    // The only push is the 15:00 water pace nudge; the missed lunch is never pushed.
    expect(t.pushed.map((p) => p.title)).toEqual(["Water"]);
  });

  it("stays silent while a class is in progress", async () => {
    const t = setup({ now: at("13:00"), classes: [classRow("c-1", "12:45", "14:15")] });
    const res = await t.call();
    expect(t.push).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ sent: 0 });
  });

  it("delivers a queued timetable alert once and marks it delivered", async () => {
    const t = setup({
      now: at("16:30"),
      mealLogs: ["breakfast", "lunch"],
      alerts: [{ id: "alert-1", summary: "OM-I-2 moved to 2:00 PM today" }],
    });
    await t.call();
    expect(t.pushed).toHaveLength(1);
    expect(t.pushed[0]).toMatchObject({
      title: "Timetable updated",
      body: "OM-I-2 moved to 2:00 PM today",
    });
    expect(t.delivered).toEqual(["alert-1"]);
    await t.call();
    expect(t.pushed).toHaveLength(1);
    expect(t.delivered).toEqual(["alert-1"]);
  });

  it("holds a queued alert during a class", async () => {
    const t = setup({
      now: at("16:30"),
      classes: [classRow("c-2", "16:00", "17:00")],
      alerts: [{ id: "alert-2", summary: "x" }],
    });
    await t.call();
    expect(t.push).not.toHaveBeenCalled();
    expect(t.delivered).toEqual([]);
  });

  it("removes a subscription the push service reports gone", async () => {
    const t = setup({ now: at("13:00"), pushStatus: 410 });
    const res = await t.call();
    expect(t.deleted).toEqual(["sub-1"]);
    expect(t.logs[0]?.status).toBe("gone");
    expect(await res.json()).toMatchObject({ sent: 0, removedSubscriptions: 1 });
    // Nothing reached a device, so lunch is not marked as sent.
    expect(t.upserts.some((u) => u.sent_count !== undefined)).toBe(false);
  });

  it("prompts for attendance once after a class ends", async () => {
    const t = setup({
      now: at("11:00"),
      mealLogs: ["breakfast"],
      classes: [classRow("c-3", "09:30", "11:00")],
    });
    await t.call();
    const prompt = t.pushed.find((p) => p.title === "How was OM-I-2?");
    expect(prompt?.data.itemKey).toBe("class:c-3:attendance");
    await t.call();
    expect(t.pushed.filter((p) => p.title === "How was OM-I-2?")).toHaveLength(1);
  });

  it("sends no meal push when the meal is already logged", async () => {
    const t = setup({ now: at("13:00"), mealLogs: ["lunch"] });
    await t.call();
    expect(t.pushed.some((p) => p.title === "Lunch")).toBe(false);
  });

  it("sends no habit nudge when its item log is done", async () => {
    const base = setup({ now: at("18:00"), mealLogs: ["breakfast", "lunch"] });
    await base.call();
    const nudge = base.pushed.find((p) => p.title.startsWith("Revision"));
    expect(nudge).toBeDefined();
    const t = setup({
      now: at("18:00"),
      mealLogs: ["breakfast", "lunch"],
      itemLogs: [{ item_key: nudge!.data.itemKey, status: "done", meta: null }],
    });
    await t.call();
    expect(t.pushed.some((p) => p.title.startsWith("Revision"))).toBe(false);
  });

  it("sends no attendance prompt once attendance is logged", async () => {
    const t = setup({
      now: at("11:00"),
      mealLogs: ["breakfast"],
      classes: [classRow("c-3", "09:30", "11:00")],
      itemLogs: [{ item_key: "class:c-3", status: "done", meta: { attendance: "attended" } }],
    });
    await t.call();
    expect(t.pushed.some((p) => p.title === "How was OM-I-2?")).toBe(false);
  });
});

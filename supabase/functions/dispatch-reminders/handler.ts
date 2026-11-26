/**
 * dispatch-reminders (T3.2b). Called every minute by pg_cron.
 *
 * Pure-ish: all I/O goes through the injected `store`, `push` and `now`, so the
 * Vitest tests run it against in-memory fakes. Logic lives in shared/ (reminder
 * engine, day plan, time); this file only gathers inputs, calls the engine and
 * persists what happened. Nothing personal is logged and no notification text is
 * stored in the database.
 */
import { signActionToken } from "../notification-action/handler.ts";
import { buildDayPlan, templateForDayKey } from "../../../shared/dayplan.ts";
import type { PlanClass } from "../../../shared/dayplan.ts";
import { waterTotals } from "../../../shared/logging.ts";
import type { WaterLogRow } from "../../../shared/logging.ts";
import {
  buildReminderItems,
  evaluate,
  quietClassIntervals,
} from "../../../shared/reminders.ts";
import type {
  ReminderClass,
  ReminderItem,
  ReminderResolution,
  ReminderSourceItem,
  ReminderState,
} from "../../../shared/reminders.ts";
import {
  DEFAULT_FACILITY_HOURS,
  type FacilityHours,
} from "../../../shared/schedule.ts";
import {
  istParts,
  pulseDayKey,
  pulseDayRange,
} from "../../../shared/time.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ALERTS_PER_RUN = 5;
/** Same night window as the reminder engine (02:00-07:00 IST). */
const NIGHT_QUIET_START_HOUR = 2;
const NIGHT_QUIET_END_HOUR = 7;
const ATTENDANCE_VALUES = new Set(["attended", "missed", "medical", "cancelled"]);

/** Subset of `public.classes` (same columns app/src/classes.ts reads). */
export interface ClassRow {
  id: string;
  kind: "class" | "exam" | "event";
  source_starts_at: string;
  source_ends_at: string;
  source_title: string;
  source_course: string | null;
  source_session: number | null;
  source_professor: string | null;
  source_room: string | null;
  source_present: boolean;
  manual_state: "none" | "cancelled" | "moved" | "edited";
  manual_starts_at: string | null;
  manual_ends_at: string | null;
  manual_title: string | null;
}

export interface ReminderRow {
  item_key: string;
  sent_count: number;
  last_sent_at: string | null;
  snoozed_until: string | null;
  resolution: ReminderResolution | null;
}

export interface ItemLogRow {
  item_key: string;
  status: "done" | "skipped" | "missed";
  meta: Record<string, unknown> | null;
}

export interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface AlertRow {
  id: string;
  summary: string;
}

export interface DayData {
  classes: ClassRow[];
  reminders: ReminderRow[];
  itemLogs: ItemLogRow[];
  mealLogs: { meal: string }[];
  waterLogs: WaterLogRow[];
  /** `settings.data.facility_hours`, unvalidated, or null when not stored. */
  facilityHours: unknown;
  subscriptions: SubscriptionRow[];
}

export interface ReminderUpsert {
  user_id: string;
  day_key: string;
  item_key: string;
  level: ReminderItem["level"];
  kind: ReminderItem["kind"];
  title: string;
  fire_at: string;
  window_end: string | null;
  /** Only present when a notification was sent. */
  sent_count?: number;
  last_sent_at?: string;
  /** Only present when the item became Missed. */
  resolution?: "missed";
  resolved_at?: string;
}

export interface NotificationLogInsert {
  user_id: string;
  item_key: string;
  day_key: string;
  kind: string;
  sent_at: string;
  status: "sent" | "failed" | "gone";
  push_subscription_id: string | null;
  error_code: string | null;
}

export interface DispatchStore {
  /** RPC public.check_dispatch_secret(candidate). */
  checkSecret(candidate: string): Promise<boolean>;
  loadDay(input: {
    ownerId: string;
    dayKey: string;
    rangeStart: string;
    rangeEnd: string;
  }): Promise<DayData>;
  upsertReminder(row: ReminderUpsert): Promise<void>;
  insertNotificationLog(row: NotificationLogInsert): Promise<void>;
  /** insert ... on conflict (user_id, day_key, item_key) do nothing */
  insertMissed(row: {
    user_id: string;
    day_key: string;
    item_key: string;
    title: string;
    missed_at: string;
  }): Promise<void>;
  deleteSubscription(ownerId: string, id: string): Promise<void>;
  pendingAlerts(ownerId: string, limit: number): Promise<AlertRow[]>;
  markAlertDelivered(ownerId: string, id: string, at: string): Promise<void>;
}

export interface PushAction {
  action: string;
  title: string;
}

export interface PushPayload {
  type: "pulse-reminder";
  title: string;
  body: string;
  tag: string;
  data: { itemKey: string; dayKey: string; url: string; actionToken?: string };
  actions: PushAction[];
}

/** Sends one encrypted push; resolves to the push service's HTTP status, rejects on network errors. */
export type SendPush = (
  subscription: SubscriptionRow,
  payload: PushPayload,
) => Promise<number>;

export interface DispatchDependencies {
  readEnv: (name: string) => string | undefined;
  store: DispatchStore;
  push: SendPush;
  now?: () => Date;
}

export interface DispatchCounts {
  sent: number;
  missed: number;
  attendancePrompts: number;
  alerts: number;
  removedSubscriptions: number;
}

const json = (body: Record<string, unknown>, status: number): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const DONE_SNOOZE_ACTIONS: PushAction[] = [
  { action: "done", title: "Done" },
  { action: "snooze", title: "Snooze 10 min" },
];
const DONE_ONLY_ACTIONS: PushAction[] = [{ action: "done", title: "Done" }];
const ATTENDANCE_ACTIONS: PushAction[] = [
  { action: "attended", title: "Attended" },
  { action: "missed", title: "Missed" },
];

/** Same mapping as app/src/classes.ts rowToPlanClass (duplicated: that module imports React). */
function rowToPlanClass(row: ClassRow): PlanClass | null {
  if (!row.source_present && row.manual_state === "none") return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.manual_title ?? row.source_title,
    startAt: new Date(row.manual_starts_at ?? row.source_starts_at),
    endAt: new Date(row.manual_ends_at ?? row.source_ends_at),
    course: row.source_course,
    room: row.source_room,
    session: row.source_session,
    professor: row.source_professor,
    cancelled: row.manual_state === "cancelled",
  };
}

/** Same filter as app/src/classes.ts mapClassRows. */
function mapClassRows(rows: ClassRow[], dayKey: string): PlanClass[] {
  const { start, end } = pulseDayRange(dayKey);
  return rows
    .map(rowToPlanClass)
    .filter(
      (c): c is PlanClass =>
        c !== null &&
        !Number.isNaN(c.startAt.getTime()) &&
        c.startAt.getTime() >= start.getTime() &&
        c.startAt.getTime() < end.getTime(),
    )
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

const HHMM = /^\d{2}:\d{2}$/;
const isPair = (v: unknown): v is [string, string] =>
  Array.isArray(v) &&
  v.length === 2 &&
  typeof v[0] === "string" &&
  typeof v[1] === "string" &&
  HHMM.test(v[0]) &&
  HHMM.test(v[1]);

/** Stored facility hours when well-formed, else the PRD defaults. */
function facilityFrom(value: unknown): FacilityHours {
  try {
    const v = value as { mess?: Record<string, unknown>; gym?: unknown };
    const mess = v.mess;
    if (
      mess &&
      isPair(mess.breakfast) &&
      isPair(mess.lunch) &&
      isPair(mess.snacks) &&
      isPair(mess.dinner) &&
      Array.isArray(v.gym) &&
      v.gym.every(isPair)
    ) {
      return value as FacilityHours;
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_FACILITY_HOURS;
}

function mealOf(title: string): string | null {
  const m = /^\s*(breakfast|lunch|snacks|dinner)\b/i.exec(title);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Item keys. Habit nudges use the app's `habit:<dayKey>:<order>` key so a habit
 * log resolves them; classes use `class:<id>` (the key attendance logs use).
 */
function sourceKey(
  dayKey: string,
  blockType: string,
  order: number | null,
  sortOrder: number,
): string {
  const n = order ?? `s${sortOrder}`;
  return blockType === "habit_nudge"
    ? `habit:${dayKey}:${n}`
    : `must:${dayKey}:${n}`;
}

function inNightQuiet(now: Date): boolean {
  const h = istParts(now).hour;
  return h >= NIGHT_QUIET_START_HOUR && h < NIGHT_QUIET_END_HOUR;
}

function reminderState(row: ReminderRow): ReminderState {
  const state: ReminderState = { sentCount: row.sent_count };
  if (row.resolution) state.resolved = row.resolution;
  if (row.snoozed_until) state.snoozedUntil = new Date(row.snoozed_until);
  if (row.last_sent_at) state.lastSentAt = new Date(row.last_sent_at);
  return state;
}

interface PushOutcome {
  delivered: number;
  removed: number;
}

export function createDispatchRemindersHandler(
  deps: DispatchDependencies,
): (request: Request) => Promise<Response> {
  const { store, push } = deps;
  const clock = deps.now ?? (() => new Date());

  return async (request) => {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const match = /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("Authorization") ?? "",
    );
    const ownerId = deps.readEnv("COLLEGE_TIMETABLE_OWNER_ID");
    if (!ownerId || !UUID_PATTERN.test(ownerId)) {
      return json({ error: "Server configuration error" }, 500);
    }
    let authorized = false;
    if (match) {
      try {
        authorized = await store.checkSecret(match[1]!);
      } catch {
        return json({ error: "Dispatch failed" }, 500);
      }
    }
    if (!authorized) return json({ error: "Authentication required" }, 401);

    const counts: DispatchCounts = {
      sent: 0,
      missed: 0,
      attendancePrompts: 0,
      alerts: 0,
      removedSubscriptions: 0,
    };

    try {
      const now = clock();
      const nowIso = now.toISOString();
      const dayKey = pulseDayKey(now);
      const range = pulseDayRange(dayKey);
      const data = await store.loadDay({
        ownerId,
        dayKey,
        rangeStart: range.start.toISOString(),
        rangeEnd: range.end.toISOString(),
      });

      const planClasses = mapClassRows(data.classes, dayKey);
      const plan = buildDayPlan(templateForDayKey(dayKey), dayKey, [], planClasses);

      const sources: ReminderSourceItem[] = plan.items
        .filter((i) => i.source === "template")
        .map((i) => ({
          key: sourceKey(dayKey, i.blockType, i.templateBlockSortOrder, i.sortOrder),
          title: i.title,
          blockType: i.blockType,
          startAt: i.startAt,
          endAt: i.endAt,
          meta: i.meta,
        }));
      const reminderClasses: ReminderClass[] = planClasses.map((c) => ({
        key: `class:${c.id}`,
        title: c.title,
        start: c.startAt,
        end: c.endAt,
        cancelled: c.cancelled,
      }));
      const items = buildReminderItems({
        dayKey,
        items: sources,
        classes: reminderClasses,
        facility: facilityFrom(data.facilityHours),
      });
      const itemByKey = new Map(items.map((i) => [i.key, i]));

      // State: stored rows first, then anything already resolved by a log.
      const state: Record<string, ReminderState | undefined> = {};
      const sentCounts = new Map<string, number>();
      for (const row of data.reminders) {
        state[row.item_key] = reminderState(row);
        sentCounts.set(row.item_key, row.sent_count);
      }
      const loggedMeals = new Set(data.mealLogs.map((m) => m.meal));
      const logByKey = new Map(data.itemLogs.map((l) => [l.item_key, l]));
      for (const item of items) {
        const st = (state[item.key] ??= { sentCount: 0 })!;
        if (st.resolved) continue;
        if (item.attendance) {
          const log = logByKey.get(item.key.slice(0, -":attendance".length));
          const att = log?.meta?.attendance;
          if (typeof att === "string" && ATTENDANCE_VALUES.has(att)) {
            st.resolved = "done";
          }
          continue;
        }
        if (item.kind === "class") continue;
        const meal = item.kind === "meal" ? mealOf(item.title) : null;
        if (meal && loggedMeals.has(meal)) {
          st.resolved = "done";
          continue;
        }
        const log = logByKey.get(item.key);
        if (log) st.resolved = log.status;
      }

      const call = plan.items.find(
        (i) => /^personal call\b/i.test(i.title) && i.startAt && i.endAt,
      );
      const result = evaluate({
        items,
        state,
        quiet: {
          classes: quietClassIntervals(reminderClasses),
          call: call ? { start: call.startAt!, end: call.endAt! } : null,
        },
        waterBottles: waterTotals(data.waterLogs).bottles,
        now,
      });

      const deliver = async (
        itemKey: string,
        kind: string,
        payload: PushPayload,
      ): Promise<PushOutcome> => {
        const out: PushOutcome = { delivered: 0, removed: 0 };
        await Promise.all(
          data.subscriptions.map(async (sub) => {
            let status: NotificationLogInsert["status"] = "failed";
            let errorCode: string | null = null;
            try {
              const http = await push(sub, payload);
              if (http >= 200 && http < 300) status = "sent";
              else if (http === 404 || http === 410) status = "gone";
              else errorCode = String(http);
            } catch {
              errorCode = "network";
            }
            if (status === "sent") out.delivered += 1;
            if (status === "gone") {
              out.removed += 1;
              await store.deleteSubscription(ownerId, sub.id);
            }
            await store.insertNotificationLog({
              user_id: ownerId,
              item_key: itemKey,
              day_key: dayKey,
              kind,
              sent_at: nowIso,
              status,
              push_subscription_id: status === "gone" ? null : sub.id,
              error_code: status === "gone" ? "gone" : errorCode,
            });
          }),
        );
        counts.removedSubscriptions += out.removed;
        return out;
      };

      const baseRow = (item: ReminderItem): ReminderUpsert => ({
        user_id: ownerId,
        day_key: dayKey,
        item_key: item.key,
        level: item.level,
        kind: item.kind,
        title: item.title,
        fire_at: item.fireAt.toISOString(),
        window_end: item.windowEnd ? item.windowEnd.toISOString() : null,
      });

      const recordSent = async (item: ReminderItem): Promise<void> => {
        await store.upsertReminder({
          ...baseRow(item),
          sent_count: (sentCounts.get(item.key) ?? 0) + 1,
          last_sent_at: nowIso,
        });
      };

      // Signed per item so the notification's Done / Snooze / Skip can reach the backend.
      const tokenSecret = deps.readEnv("SUPABASE_SERVICE_ROLE_KEY");
      const tokenFor = async (itemKey: string): Promise<{ actionToken?: string }> =>
        tokenSecret
          ? { actionToken: await signActionToken(tokenSecret, ownerId, dayKey, itemKey, now) }
          : {};

      for (const n of result.send) {
        const item = itemByKey.get(n.key);
        if (!item) continue;
        const outcome = await deliver(n.key, n.kind, {
          type: "pulse-reminder",
          title: n.title,
          body: n.body,
          tag: n.key,
          data: {
            itemKey: n.key,
            dayKey,
            url: `/?focus=${encodeURIComponent(n.key)}`,
            ...(await tokenFor(n.key)),
          },
          actions: item.level === "nudge" ? DONE_ONLY_ACTIONS : DONE_SNOOZE_ACTIONS,
        });
        // Retry next minute if nothing reached a device.
        if (outcome.delivered > 0) {
          await recordSent(item);
          counts.sent += 1;
        }
      }

      for (const key of result.attendancePrompts) {
        const item = itemByKey.get(key);
        if (!item) continue;
        const outcome = await deliver(key, "class", {
          type: "pulse-reminder",
          title: `How was ${item.title}?`,
          body: "Tell Pulse if you attended.",
          tag: key,
          data: {
            itemKey: key,
            dayKey,
            url: `/?focus=${encodeURIComponent(key)}`,
            ...(await tokenFor(key)),
          },
          actions: ATTENDANCE_ACTIONS,
        });
        if (outcome.delivered > 0) {
          await recordSent(item);
          counts.attendancePrompts += 1;
        }
      }

      for (const key of result.missed) {
        const item = itemByKey.get(key);
        if (!item) continue;
        await store.upsertReminder({
          ...baseRow(item),
          resolution: "missed",
          resolved_at: nowIso,
        });
        await store.insertMissed({
          user_id: ownerId,
          day_key: dayKey,
          item_key: key,
          title: item.title,
          missed_at: nowIso,
        });
        counts.missed += 1;
      }

      // Timetable change alerts: held during a class or the night quiet window.
      const heldForQuiet =
        inNightQuiet(now) ||
        quietClassIntervals(reminderClasses).some(
          (iv) =>
            now.getTime() >= iv.start.getTime() && now.getTime() < iv.end.getTime(),
        );
      if (!heldForQuiet) {
        const alerts = await store.pendingAlerts(ownerId, MAX_ALERTS_PER_RUN);
        for (const alert of alerts.slice(0, MAX_ALERTS_PER_RUN)) {
          const itemKey = `alert:${alert.id}`;
          const outcome = await deliver(itemKey, "other", {
            type: "pulse-reminder",
            title: "Timetable updated",
            body: alert.summary,
            tag: itemKey,
            data: { itemKey, dayKey, url: "/" },
            actions: [],
          });
          if (outcome.delivered > 0) {
            await store.markAlertDelivered(ownerId, alert.id, nowIso);
            counts.alerts += 1;
          }
        }
      }
    } catch {
      // Never log request data, subscriptions or notification text.
      return json({ error: "Dispatch failed" }, 500);
    }

    return json({ ok: true, ...counts }, 200);
  };
}

import "../_shared/base64-polyfill.ts";
import { encrypt, vapidPublicKey } from "jsr:@daaku/webpush@0.2.0";
import { postEncryptedPush } from "../_shared/push.ts";
import {
  createDispatchRemindersHandler,
  type AlertRow,
  type DayData,
  type DispatchStore,
  type ItemLogRow,
  type ReminderRow,
  type SendPush,
  type SubscriptionRow,
} from "./handler.ts";

const REQUEST_TIMEOUT_MS = 8000;
/** Reminders are useless when late: let the push service drop them after 5 minutes. */
const PUSH_TTL_SECONDS = 300;

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Missing configuration");
  return value;
}

function createStore(supabaseUrl: string, serviceRoleKey: string): DispatchStore {
  const base = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}/${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const ok = async (path: string, init?: RequestInit): Promise<Response> => {
    const res = await call(path, init);
    if (!res.ok) throw new Error("Database request failed");
    return res;
  };
  const rows = async <T>(path: string): Promise<T[]> =>
    (await (await ok(path)).json()) as T[];
  const q = (params: Record<string, string>): string =>
    new URLSearchParams(params).toString();

  return {
    async checkSecret(candidate) {
      const res = await ok("rpc/check_dispatch_secret", {
        method: "POST",
        body: JSON.stringify({ candidate }),
      });
      return (await res.json()) === true;
    },

    async loadDay({ ownerId, dayKey, rangeStart, rangeEnd }): Promise<DayData> {
      const user = `eq.${ownerId}`;
      const day = `eq.${dayKey}`;
      const classFilter =
        `(and(manual_starts_at.gte.${rangeStart},manual_starts_at.lt.${rangeEnd}),` +
        `and(manual_starts_at.is.null,source_starts_at.gte.${rangeStart},source_starts_at.lt.${rangeEnd}))`;
      const [classes, reminders, itemLogs, mealLogs, waterLogs, settings, subscriptions] =
        await Promise.all([
          rows<DayData["classes"][number]>(
            `classes?${q({
              select:
                "id,kind,source_starts_at,source_ends_at,source_title,source_course,source_session,source_professor,source_room,source_present,manual_state,manual_starts_at,manual_ends_at,manual_title",
              user_id: user,
              or: classFilter,
              order: "source_starts_at.asc",
            })}`,
          ),
          rows<ReminderRow>(
            `reminders?${q({
              select: "item_key,sent_count,last_sent_at,snoozed_until,resolution",
              user_id: user,
              day_key: day,
            })}`,
          ),
          rows<ItemLogRow>(
            `item_logs?${q({ select: "item_key,status,meta", user_id: user, day_key: day })}`,
          ),
          rows<{ meal: string }>(
            `meal_logs?${q({ select: "meal", user_id: user, day_key: day })}`,
          ),
          rows<DayData["waterLogs"][number]>(
            `water_logs?${q({ select: "amount_ml,is_gym", user_id: user, day_key: day })}`,
          ),
          rows<{ data: { facility_hours?: unknown } | null }>(
            `settings?${q({ select: "data", user_id: user })}`,
          ),
          rows<SubscriptionRow>(
            `push_subscriptions?${q({ select: "id,endpoint,p256dh,auth", user_id: user })}`,
          ),
        ]);
      return {
        classes,
        reminders,
        itemLogs,
        mealLogs,
        waterLogs,
        facilityHours: settings[0]?.data?.facility_hours ?? null,
        subscriptions,
      };
    },

    async upsertReminder(row) {
      await ok("reminders?on_conflict=user_id,day_key,item_key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
    },

    async insertNotificationLog(row) {
      await ok("notification_log", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(row),
      });
    },

    async insertMissed(row) {
      await ok("missed_items?on_conflict=user_id,day_key,item_key", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
    },

    async deleteSubscription(ownerId, id) {
      await ok(`push_subscriptions?${q({ id: `eq.${id}`, user_id: `eq.${ownerId}` })}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      });
    },

    async pendingAlerts(ownerId, limit) {
      return await rows<AlertRow>(
        `timetable_change_alerts?${q({
          select: "id,summary",
          user_id: `eq.${ownerId}`,
          delivered_at: "is.null",
          order: "queued_at.asc,id.asc",
          limit: String(limit),
        })}`,
      );
    },

    async markAlertDelivered(ownerId, id, at) {
      await ok(
        `timetable_change_alerts?${q({ id: `eq.${id}`, user_id: `eq.${ownerId}` })}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ delivered_at: at }),
        },
      );
    },
  };
}

function createPush(): SendPush {
  const vapidPrivateKey = JSON.parse(requireEnv("VAPID_PRIVATE_KEY")) as JsonWebKey;
  const vapidSubject = requireEnv("VAPID_SUBJECT");
  const checked = vapidPublicKey(vapidPrivateKey).then((key) => {
    if (key !== requireEnv("VAPID_PUBLIC_KEY")) throw new Error("Push is not configured");
  });
  checked.catch(() => undefined);
  const timedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  return async (subscription, payload) => {
    await checked;
    const encrypted = await encrypt(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { vapid: vapidPrivateKey, subscriber: vapidSubject, ttl: PUSH_TTL_SECONDS },
    );
    const response = await postEncryptedPush(encrypted, timedFetch);
    // Drain the body so the connection is released; never read or log it.
    await response.body?.cancel();
    return response.status;
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

Deno.serve((request) => {
  try {
    handler ??= createDispatchRemindersHandler({
      readEnv: (name) => Deno.env.get(name),
      store: createStore(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY")),
      push: createPush(),
    });
  } catch {
    return Response.json({ error: "Server configuration error" }, { status: 500 });
  }
  return handler(request);
});

import {
  handleNotificationActionRequest,
  type AppliedNotificationAction,
  type NotificationActionStore,
  type NotificationAction,
  pushCorsHeaders,
} from "../_shared/push.ts";
import {
  handleReminderActionRequest,
  isReminderActionBody,
  type ReminderActionStore,
  type StoredReminder,
} from "./handler.ts";

const REQUEST_TIMEOUT_MS = 8000;

function createReminderStore(
  supabaseUrl: string,
  serviceRoleKey: string,
): ReminderActionStore {
  const base = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1`;
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    const res = await fetch(`${base}/${path}`, {
      ...init,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("Database request failed");
    return res;
  };
  const match = (userId: string, dayKey: string, itemKey: string) => ({
    user_id: `eq.${userId}`,
    day_key: `eq.${dayKey}`,
    item_key: `eq.${itemKey}`,
  });
  const patchOpen = (
    userId: string,
    dayKey: string,
    itemKey: string,
    body: Record<string, unknown>,
  ) =>
    call(
      `reminders?${new URLSearchParams({
        ...match(userId, dayKey, itemKey),
        resolution: "is.null",
      })}`,
      { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) },
    );

  return {
    async getReminder(userId, dayKey, itemKey) {
      const res = await call(
        `reminders?${new URLSearchParams({
          select: "kind,resolution,snoozed_until",
          ...match(userId, dayKey, itemKey),
          limit: "1",
        })}`,
        { method: "GET" },
      );
      const rows = (await res.json()) as StoredReminder[];
      return rows[0] ?? null;
    },
    async resolveReminder(userId, dayKey, itemKey, patch) {
      await patchOpen(userId, dayKey, itemKey, patch);
    },
    async snoozeReminder(userId, dayKey, itemKey, snoozedUntil) {
      await patchOpen(userId, dayKey, itemKey, { snoozed_until: snoozedUntil });
    },
    async upsertItemLog(row, overwrite) {
      await call("item_logs?on_conflict=user_id,day_key,item_key", {
        method: "POST",
        headers: {
          Prefer: `resolution=${overwrite ? "merge" : "ignore"}-duplicates,return=minimal`,
        },
        body: JSON.stringify(row),
      });
    },
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: pushCorsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json(
      { error: "Action callback is unavailable" },
      { status: 503, headers: pushCorsHeaders },
    );
  }

  const rpcUrl = new URL("/rest/v1/rpc/apply_notification_action", supabaseUrl);
  const store: NotificationActionStore = {
    async apply({ notificationId, capabilityHash, action }) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_notification_id: notificationId,
          p_capability_hash: capabilityHash,
          p_action: action,
        }),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Unable to apply action");

      const data = await response.json().catch(() => null);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      const result = row as {
        action?: unknown;
        snoozed_until?: unknown;
        idempotent?: unknown;
      };
      if (
        (result.action !== "done" && result.action !== "snooze") ||
        (result.snoozed_until !== null &&
          typeof result.snoozed_until !== "string") ||
        typeof result.idempotent !== "boolean"
      ) {
        throw new Error("Invalid action result");
      }
      return {
        action: result.action as NotificationAction,
        snoozed_until: result.snoozed_until as string | null,
        idempotent: result.idempotent,
      } satisfies AppliedNotificationAction;
    },
  };

  // Reminder actions carry an `actionToken`; the Phase 0 test push does not.
  if (request.method === "POST") {
    const peek: unknown = await request.clone().json().catch(() => null);
    if (isReminderActionBody(peek)) {
      return await handleReminderActionRequest(request, {
        secret: serviceRoleKey,
        store: createReminderStore(supabaseUrl, serviceRoleKey),
      });
    }
  }

  return await handleNotificationActionRequest(request, store);
});

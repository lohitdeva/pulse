import {
  handleNotificationActionRequest,
  type AppliedNotificationAction,
  type NotificationActionStore,
  type NotificationAction,
  pushCorsHeaders,
} from "../_shared/push.ts";

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

  return await handleNotificationActionRequest(request, store);
});

import "../_shared/base64-polyfill.ts";
import { encrypt, vapidPublicKey } from "jsr:@daaku/webpush@0.2.0";
import {
  hashCapability,
  isAllowedPushEndpoint,
  newActionCapability,
  postEncryptedPush,
  pushCorsHeaders,
} from "../_shared/push.ts";

const json = (body: Record<string, unknown>, status: number) =>
  Response.json(body, { status, headers: pushCorsHeaders });

function readRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error("Missing configuration");
  return value;
}

function apiUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  return new URL(path.replace(/^\/+/, ""), `${base.href.replace(/\/+$/, "")}/`);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: pushCorsHeaders });
  }
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return json({ error: "Authentication required" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "Invalid request" }, 400);
  }
  const subscriptionId = (body as Record<string, unknown>).subscriptionId;
  if (
    typeof subscriptionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      subscriptionId,
    )
  ) {
    return json({ error: "Invalid subscription" }, 400);
  }

  try {
    const supabaseUrl = readRequiredEnv("SUPABASE_URL");
    const anonKey = readRequiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const vapidPrivateKey = JSON.parse(
      readRequiredEnv("VAPID_PRIVATE_KEY"),
    ) as JsonWebKey;
    const configuredPublicKey = readRequiredEnv("VAPID_PUBLIC_KEY");
    const vapidSubscriber = readRequiredEnv("VAPID_SUBJECT");
    const publicKey = await vapidPublicKey(vapidPrivateKey);
    if (publicKey !== configuredPublicKey) {
      return json({ error: "Push is not configured" }, 500);
    }

    const authResponse = await fetch(apiUrl(supabaseUrl, "/auth/v1/user"), {
      headers: { apikey: anonKey, Authorization: `Bearer ${match[1]}` },
      redirect: "error",
    });
    if (!authResponse.ok) {
      return json({ error: "Authentication required" }, 401);
    }
    const userResult = (await authResponse.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    if (typeof userResult?.id !== "string") {
      return json({ error: "Authentication required" }, 401);
    }

    const subscriptionUrl = apiUrl(supabaseUrl, "/rest/v1/push_subscriptions");
    subscriptionUrl.searchParams.set("select", "id,endpoint,p256dh,auth");
    subscriptionUrl.searchParams.set("id", `eq.${subscriptionId}`);
    subscriptionUrl.searchParams.set("user_id", `eq.${userResult.id}`);
    const subscriptionResponse = await fetch(subscriptionUrl, {
      headers: { apikey: anonKey, Authorization: `Bearer ${match[1]}` },
      redirect: "error",
    });
    if (!subscriptionResponse.ok) {
      return json({ error: "Subscription not found" }, 404);
    }
    const subscriptions = (await subscriptionResponse
      .json()
      .catch(() => null)) as
      | {
          id?: unknown;
          endpoint?: unknown;
          p256dh?: unknown;
          auth?: unknown;
        }[]
      | null;
    const subscription = Array.isArray(subscriptions) ? subscriptions[0] : null;
    if (
      !subscription ||
      typeof subscription.endpoint !== "string" ||
      typeof subscription.p256dh !== "string" ||
      typeof subscription.auth !== "string"
    ) {
      return json({ error: "Subscription not found" }, 404);
    }
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      return json({ error: "Subscription endpoint is not supported" }, 400);
    }

    const notificationId = crypto.randomUUID();
    const capability = newActionCapability();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const capabilityResponse = await fetch(
      apiUrl(supabaseUrl, "/rest/v1/notification_action_capabilities"),
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          notification_id: notificationId,
          user_id: userResult.id,
          capability_hash: await hashCapability(capability),
          expires_at: expiresAt,
        }),
        redirect: "error",
      },
    );
    if (!capabilityResponse.ok) {
      return json({ error: "Unable to prepare notification" }, 503);
    }

    const actionEndpoint = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/notification-action`;
    const payload = {
      type: "pulse-test",
      notificationId,
      capability,
      actionEndpoint,
      title: "Pulse push test",
      body: "Web Push delivery is working.",
      actions: [
        { action: "done", title: "Done" },
        { action: "snooze", title: "Snooze 10 min" },
      ],
    };

    const encrypted = await encrypt(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { vapid: vapidPrivateKey, subscriber: vapidSubscriber, ttl: 60 },
    );
    const pushResponse = await postEncryptedPush(encrypted);
    if (!pushResponse.ok)
      return json({ error: "Push service rejected the message" }, 502);

    return json({ ok: true, notificationId, vapidPublicKey: publicKey }, 200);
  } catch {
    // Do not log credentials, subscription endpoints, or push-service response bodies.
    return json({ error: "Unable to send test push" }, 502);
  }
});

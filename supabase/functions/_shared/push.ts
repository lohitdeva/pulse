export const pushCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const knownPushServices = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

export type NotificationAction = "done" | "snooze";

export interface AppliedNotificationAction {
  action: NotificationAction;
  snoozed_until: string | null;
  idempotent: boolean;
}

export interface NotificationActionStore {
  apply(input: {
    notificationId: string;
    capabilityHash: string;
    action: NotificationAction;
  }): Promise<AppliedNotificationAction | null>;
}

export interface EncryptedPushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !knownPushServices.has(url.hostname.toLowerCase())
    ) {
      return false;
    }

    if (url.hostname === "fcm.googleapis.com") {
      return /^\/fcm\/send\/[^/?#]+\/?$/.test(url.pathname);
    }
    if (url.hostname === "updates.push.services.mozilla.com") {
      return /^\/wpush\/v2\/[^/?#]+\/?$/.test(url.pathname);
    }
    return /^\/[^/?#]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export async function postEncryptedPush(
  encrypted: EncryptedPushRequest,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!isAllowedPushEndpoint(encrypted.endpoint)) {
    throw new Error("Unsupported push endpoint");
  }
  return await fetcher(encrypted.endpoint, {
    method: "POST",
    headers: encrypted.headers,
    body: encrypted.body,
    redirect: "error",
  });
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function hashCapability(capability: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(capability),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

export function newActionCapability(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: pushCorsHeaders });
}

export async function handleNotificationActionRequest(
  request: Request,
  store: NotificationActionStore,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: pushCorsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request" }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse({ error: "Invalid request" }, 400);
  }

  const input = body as Record<string, unknown>;
  const notificationId = input.notificationId;
  const capability = input.capability;
  const action = input.action;
  if (
    typeof notificationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      notificationId,
    ) ||
    (action !== "done" && action !== "snooze") ||
    typeof capability !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(capability)
  ) {
    return jsonResponse({ error: "Invalid request" }, 400);
  }

  try {
    const applied = await store.apply({
      notificationId,
      capabilityHash: await hashCapability(capability),
      action,
    });

    if (!applied) {
      return jsonResponse({ error: "Invalid or expired action" }, 401);
    }
    if (applied.action !== action) {
      return jsonResponse({ error: "Notification already handled" }, 409);
    }

    return jsonResponse(
      {
        notificationId,
        action: applied.action,
        snoozedUntil: applied.snoozed_until,
        idempotent: applied.idempotent,
      },
      200,
    );
  } catch {
    return jsonResponse({ error: "Unable to save notification action" }, 503);
  }
}

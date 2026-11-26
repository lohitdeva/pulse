import { describe, expect, it, vi } from "vitest";
import {
  decodeApplicationServerKey,
  enrollPushSubscription,
  focusNotificationPanel,
  installPushWorkerHandlers,
  NOTIFICATION_TEST_HASH,
  sendTestPush,
  type PushWorkerScope,
} from "./push";

const notificationId = "8b4df36e-8ef6-4a3b-a3c3-49de1b696920";
const capability = "A".repeat(43);
const actionEndpoint =
  "https://pulse.example.supabase.co/functions/v1/notification-action";
const apikey = "public-publishable-key";

describe("push enrollment", () => {
  it("reuses an existing browser subscription and upserts it by user and endpoint", async () => {
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/token",
      toJSON: () => ({ keys: { p256dh: "public-key", auth: "auth-key" } }),
    };
    const pushManager = {
      getSubscription: vi.fn(async () => subscription),
      subscribe: vi.fn(),
    };
    const upsert = vi.fn(async () => "subscription-id");
    const requestPermission = vi.fn(async () => "granted" as NotificationPermission);

    const result = await enrollPushSubscription({
      permission: "default",
      requestPermission,
      pushManager,
      userId: "user-id",
      vapidPublicKey: "AQID",
      upsert,
    });

    expect(result).toEqual({ status: "granted", subscriptionId: "subscription-id" });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(pushManager.getSubscription).toHaveBeenCalledOnce();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({
      user_id: "user-id",
      endpoint: subscription.endpoint,
      p256dh: "public-key",
      auth: "auth-key",
    });
    expect(decodeApplicationServerKey("AQID")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("does not subscribe or save when permission is denied", async () => {
    const requestPermission = vi.fn(async () => "denied" as NotificationPermission);
    const pushManager = {
      getSubscription: vi.fn(),
      subscribe: vi.fn(),
    };
    const upsert = vi.fn();

    const result = await enrollPushSubscription({
      permission: "default",
      requestPermission,
      pushManager,
      userId: "user-id",
      vapidPublicKey: "AQID",
      upsert,
    });

    expect(result).toEqual({ status: "denied" });
    expect(pushManager.getSubscription).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("sends the authenticated test request to the Supabase function", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const sent = await sendTestPush(
      {
        supabaseUrl: "https://pulse.example.supabase.co",
        apikey,
        accessToken: "user-jwt",
        subscriptionId: "subscription-id",
      },
      fetcher,
    );

    expect(sent).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "https://pulse.example.supabase.co/functions/v1/send-test-push",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: {
          apikey,
          Authorization: "Bearer user-jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ subscriptionId: "subscription-id" }),
      }),
    );
  });
});

describe("service worker push actions", () => {
  it("posts Done and Snooze to the exact configured backend with the public key", async () => {
    const { scope, handlers } = makeWorkerScope();
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    installPushWorkerHandlers(scope, fetcher);
    await configureWorker(handlers, actionEndpoint);

    await dispatchPush(handlers, {
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
    });

    await dispatchClick(handlers, "done", notificationData());
    await dispatchClick(handlers, "snooze", notificationData());

    expect(scope.registration.showNotification).toHaveBeenCalledWith(
      "Pulse push test",
      expect.objectContaining({
        body: "Web Push delivery is working.",
        actions: [
          { action: "done", title: "Done" },
          { action: "snooze", title: "Snooze 10 min" },
        ],
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      actionEndpoint,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { apikey, "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId, action: "done", capability }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      actionEndpoint,
      expect.objectContaining({
        headers: { apikey, "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId, action: "snooze", capability }),
      }),
    );
  });

  it("rejects a different action destination and opens the test panel on body click", async () => {
    const { scope, handlers } = makeWorkerScope();
    const openedWindow = {
      url: `https://pulse.example/${NOTIFICATION_TEST_HASH}`,
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    vi.mocked(scope.clients.openWindow).mockResolvedValue(openedWindow);
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    installPushWorkerHandlers(scope, fetcher);
    await configureWorker(handlers, actionEndpoint);

    await dispatchClick(handlers, "done", {
      ...notificationData(),
      actionEndpoint: "https://attacker.example/collect",
    });
    await dispatchClick(handlers, "", notificationData());

    expect(fetcher).not.toHaveBeenCalled();
    expect(scope.clients.openWindow).toHaveBeenCalledWith(
      `https://pulse.example/${NOTIFICATION_TEST_HASH}`,
    );
    expect(openedWindow.focus).toHaveBeenCalledOnce();
  });

  it("navigates an already open Pulse window to the test panel before focusing it", async () => {
    const { scope, handlers } = makeWorkerScope();
    const currentWindow = {
      url: "https://pulse.example/dev",
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    vi.mocked(scope.clients.matchAll).mockResolvedValue([
      currentWindow,
    ] as unknown as Awaited<ReturnType<typeof scope.clients.matchAll>>);
    installPushWorkerHandlers(scope);

    await dispatchClick(handlers, "", notificationData());

    expect(currentWindow.navigate).toHaveBeenCalledWith(
      `https://pulse.example/${NOTIFICATION_TEST_HASH}`,
    );
    expect(currentWindow.focus).toHaveBeenCalledOnce();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });

  it("refocuses an already open test panel without navigating it", async () => {
    const { scope, handlers } = makeWorkerScope();
    const currentWindow = {
      url: `https://pulse.example/${NOTIFICATION_TEST_HASH}`,
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    vi.mocked(scope.clients.matchAll).mockResolvedValue([
      currentWindow,
    ] as unknown as Awaited<ReturnType<typeof scope.clients.matchAll>>);
    installPushWorkerHandlers(scope);

    await dispatchClick(handlers, "", notificationData());

    expect(currentWindow.navigate).not.toHaveBeenCalled();
    expect(currentWindow.focus).toHaveBeenCalledOnce();
    expect(scope.clients.openWindow).not.toHaveBeenCalled();
  });
});

describe("notification test panel focus", () => {
  it("focuses the panel only for the static test-push hash", () => {
    const panel = { focus: vi.fn() };

    focusNotificationPanel(panel, NOTIFICATION_TEST_HASH);
    focusNotificationPanel(panel, "");

    expect(panel.focus).toHaveBeenCalledOnce();
    expect(panel.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

function makeWorkerScope() {
  const stored = new Map<string, string>();
  const cache = {
    async put(key: string, response: Response) {
      stored.set(key, await response.text());
    },
    async match(key: string) {
      const value = stored.get(key);
      return value ? new Response(value) : undefined;
    },
  };
  const handlers = new Map<string, (event: unknown) => void>();
  const scope = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      handlers.set(type, handler);
    },
    caches: { open: async () => cache },
    location: { origin: "https://pulse.example" },
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      matchAll: vi.fn(async () => []),
      openWindow: vi.fn(async () => undefined),
    },
  } as unknown as PushWorkerScope;

  return { scope, handlers };
}

function notificationData() {
  return { notificationId, capability, actionEndpoint };
}

async function configureWorker(
  handlers: Map<string, (event: unknown) => void>,
  endpoint: string,
) {
  const pending: Promise<unknown>[] = [];
  handlers.get("message")?.({
    data: { type: "pulse-push-config", actionEndpoint: endpoint, apikey },
    ports: [{ postMessage: vi.fn() }],
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
}

async function dispatchPush(
  handlers: Map<string, (event: unknown) => void>,
  payload: unknown,
) {
  const pending: Promise<unknown>[] = [];
  handlers.get("push")?.({
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
}

async function dispatchClick(
  handlers: Map<string, (event: unknown) => void>,
  action: string,
  data: unknown,
) {
  const pending: Promise<unknown>[] = [];
  handlers.get("notificationclick")?.({
    action,
    notification: { data, close: vi.fn() },
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
}

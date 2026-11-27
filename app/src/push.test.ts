import { describe, expect, it, vi } from "vitest";
import {
  configurePushWorker,
  decodeApplicationServerKey,
  enrollPushSubscription,
  focusNotificationPanel,
  installPushWorkerHandlers,
  NOTIFICATION_TEST_HASH,
  refreshPushWorkerConfiguration,
  reminderActionsFor,
  requestPushPermission,
  runPushStage,
  sendTestPush,
  type PushWorkerMessenger,
  type PushWorkerScope,
} from "./push";

const notificationId = "8b4df36e-8ef6-4a3b-a3c3-49de1b696920";
const capability = "A".repeat(43);
const actionEndpoint =
  "https://pulse.example.supabase.co/functions/v1/notification-action";
const apikey = "public-publishable-key";

describe("push enrollment", () => {
  it("requests permission immediately and bounds a stalled prompt so retry works", async () => {
    vi.useFakeTimers();
    try {
      const requestPermission = vi.fn(
        () => new Promise<NotificationPermission>(() => undefined),
      );
      const pending = requestPushPermission("default", requestPermission);

      expect(requestPermission).toHaveBeenCalledOnce();
      const timedOut = expect(pending).rejects.toThrow(
        "The browser permission prompt did not finish. Check notification settings, then retry.",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await timedOut;

      await expect(
        requestPushPermission("default", async () => "granted"),
      ).resolves.toBe("granted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds stalled service worker readiness and allows the same stage to retry", async () => {
    vi.useFakeTimers();
    try {
      const pending = runPushStage(
        () => new Promise<string>(() => undefined),
        1_000,
        "Pulse service worker did not become ready. Refresh and retry.",
      );
      const timedOut = expect(pending).rejects.toThrow(
        "Pulse service worker did not become ready. Refresh and retry.",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await timedOut;

      await expect(
        runPushStage(() => Promise.resolve("active"), 1_000, "unreachable"),
      ).resolves.toBe("active");
    } finally {
      vi.useRealTimers();
    }
  });

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
    const requestPermission = vi.fn(
      async () => "granted" as NotificationPermission,
    );

    const result = await enrollPushSubscription({
      permission: "default",
      requestPermission,
      pushManager,
      userId: "user-id",
      vapidPublicKey: "AQID",
      upsert,
    });

    expect(result).toEqual({
      status: "granted",
      subscriptionId: "subscription-id",
    });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(pushManager.getSubscription).toHaveBeenCalledOnce();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({
      user_id: "user-id",
      endpoint: subscription.endpoint,
      p256dh: "public-key",
      auth: "auth-key",
    });
    expect(decodeApplicationServerKey("AQID")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("times out a stalled save and retries with the existing browser subscription", async () => {
    vi.useFakeTimers();
    try {
      const subscription = {
        endpoint: "https://fcm.googleapis.com/fcm/send/token",
        toJSON: () => ({ keys: { p256dh: "public-key", auth: "auth-key" } }),
      };
      const pushManager = {
        getSubscription: vi.fn(async () => subscription),
        subscribe: vi.fn(),
      };
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const pending = enrollPushSubscription({
        permission: "granted",
        requestPermission: vi.fn(),
        pushManager,
        userId: "user-id",
        vapidPublicKey: "AQID",
        upsert: vi.fn(
          () =>
            new Promise<string>(() => {
              signalStarted();
            }),
        ),
      });
      const timedOut = expect(pending).rejects.toThrow(
        "Could not save the push subscription. Check your connection and retry.",
      );
      await started;
      await vi.advanceTimersByTimeAsync(10_000);
      await timedOut;

      const result = await enrollPushSubscription({
        permission: "granted",
        requestPermission: vi.fn(),
        pushManager,
        userId: "user-id",
        vapidPublicKey: "AQID",
        upsert: async () => "subscription-id",
      });

      expect(result).toEqual({
        status: "granted",
        subscriptionId: "subscription-id",
      });
      expect(pushManager.getSubscription).toHaveBeenCalledTimes(2);
      expect(pushManager.subscribe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not subscribe or save when permission is denied", async () => {
    const requestPermission = vi.fn(
      async () => "denied" as NotificationPermission,
    );
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
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
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
  it("bounds a stalled worker configuration handshake and can retry", async () => {
    vi.useFakeTimers();
    const channels: Array<{
      port1: {
        onmessage: ((event: MessageEvent<unknown>) => void) | null;
        close: ReturnType<typeof vi.fn>;
      };
      port2: { close: ReturnType<typeof vi.fn> };
    }> = [];
    class FakeMessageChannel {
      port1 = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        close: vi.fn(),
      };
      port2 = { close: vi.fn() };

      constructor() {
        channels.push(this);
      }
    }
    vi.stubGlobal("MessageChannel", FakeMessageChannel);

    try {
      let respond = false;
      const worker: PushWorkerMessenger = {
        postMessage: vi.fn(() => {
          if (respond) {
            channels.at(-1)?.port1.onmessage?.({
              data: { ok: true },
            } as MessageEvent<unknown>);
          }
        }),
      };
      const configuration = { actionEndpoint, apikey };
      const pending = configurePushWorker(worker, configuration);
      const timedOut = expect(pending).rejects.toThrow(
        "Pulse service worker did not respond to push setup. Refresh the app and retry.",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await timedOut;

      respond = true;
      await expect(
        configurePushWorker(worker, configuration),
      ).resolves.toBeUndefined();
      expect(worker.postMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("refreshes the worker configuration only for an existing subscription", async () => {
    const worker: PushWorkerMessenger = {
      postMessage: vi.fn((_message: unknown, transfer: Transferable[]) => {
        (transfer[0] as MessagePort).postMessage({ ok: true });
      }),
    };
    const configuration = { actionEndpoint, apikey };
    const none = { active: worker, pushManager: { getSubscription: async () => null } };
    await expect(refreshPushWorkerConfiguration(none, configuration)).resolves.toBe(false);
    expect(worker.postMessage).not.toHaveBeenCalled();

    const enrolled = {
      active: worker,
      pushManager: { getSubscription: async () => ({ endpoint: "x" }) },
    };
    await expect(refreshPushWorkerConfiguration(enrolled, configuration)).resolves.toBe(true);
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: "pulse-push-config", ...configuration },
      expect.any(Array),
    );
  });

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

const reminderPayload = (itemKey: string, extra: Record<string, unknown> = {}) => ({
  type: "pulse-reminder",
  title: "Lunch",
  body: "Mess closes at 2:30.",
  tag: itemKey,
  data: {
    itemKey,
    dayKey: "2026-11-26",
    url: `/?focus=${encodeURIComponent(itemKey)}`,
    actionToken: "user.123.sig",
    ...extra,
  },
  actions: [],
});

describe("reminder notification action sets", () => {
  it.each([
    ["must:2026-11-26:4", 2, ["done", "snooze"]],
    ["must:2026-11-26:4", 3, ["done", "snooze", "skip"]],
    ["must:2026-11-26:4:winddown", 2, ["done", "snooze"]],
    ["habit:2026-11-26:2", 3, ["done"]],
    ["class:abc:attendance", 3, ["attended", "missed"]],
    ["alert:abc", 3, []],
    ["digest:2026-11-26", 3, []],
    ["water:11", 3, []],
  ])("%s with %i slots shows %j", (itemKey, max, expected) => {
    expect(reminderActionsFor(itemKey, max).map((a) => a.action)).toEqual(expected);
  });
});

describe("service worker reminder pushes", () => {
  it("shows every reminder payload with its item data, tag and actions", async () => {
    const { scope, handlers } = makeWorkerScope();
    installPushWorkerHandlers(scope);

    await dispatchPush(handlers, reminderPayload("must:2026-11-26:4"));
    await dispatchPush(handlers, reminderPayload("habit:2026-11-26:2"));
    await dispatchPush(handlers, reminderPayload("class:abc:attendance"));
    await dispatchPush(handlers, reminderPayload("alert:abc", { actionToken: undefined }));

    const show = vi.mocked(scope.registration.showNotification);
    expect(show).toHaveBeenCalledTimes(4);
    const actionsOf = (index: number) =>
      (show.mock.calls[index]![1] as { actions: { action: string }[] }).actions.map(
        (a) => a.action,
      );
    expect(actionsOf(0)).toEqual(["done", "snooze"]);
    expect(actionsOf(1)).toEqual(["done"]);
    expect(actionsOf(2)).toEqual(["attended", "missed"]);
    expect(actionsOf(3)).toEqual([]);
    expect(show.mock.calls[0]![1]).toMatchObject({
      tag: "must:2026-11-26:4",
      renotify: true,
      data: {
        kind: "reminder",
        itemKey: "must:2026-11-26:4",
        url: "/?focus=must%3A2026-11-26%3A4",
      },
    });
  });

  it("shows a generic notification for a malformed reminder payload", async () => {
    const { scope, handlers } = makeWorkerScope();
    installPushWorkerHandlers(scope);
    await dispatchPush(handlers, { type: "pulse-reminder", title: "x", data: {} });
    await dispatchPush(handlers, { type: "other" });

    const show = vi.mocked(scope.registration.showNotification);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toBe("Pulse reminder");
    expect(show.mock.calls[0]![1]).toMatchObject({
      data: { kind: "reminder-generic" },
    });

    await dispatchClick(handlers, "", { kind: "reminder-generic" });
    expect(scope.clients.openWindow).toHaveBeenCalledWith("https://pulse.example/");
  });

  it("shows the morning digest with no buttons and opens the morning check-in on tap", async () => {
    const { scope, handlers } = makeWorkerScope();
    installPushWorkerHandlers(scope);
    const key = "digest:2026-11-26";
    await dispatchPush(handlers, {
      ...reminderPayload(key, { url: "/?checkin=morning", actionToken: undefined }),
      title: "Today: 2 classes",
      body: "9:30 MM-II-3 · 11:15 OM-I-2",
    });
    const show = vi.mocked(scope.registration.showNotification);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]![0]).toBe("Today: 2 classes");
    expect(show.mock.calls[0]![1]).toMatchObject({
      body: "9:30 MM-II-3 · 11:15 OM-I-2",
      tag: key,
      actions: [],
      data: { kind: "reminder", itemKey: key, url: "/?checkin=morning" },
    });

    await dispatchClick(handlers, "", {
      kind: "reminder",
      itemKey: key,
      dayKey: "2026-11-26",
      url: "/?checkin=morning",
    });
    expect(scope.clients.openWindow).toHaveBeenCalledWith(
      "https://pulse.example/?checkin=morning",
    );
  });

  it("adds Skip when the platform allows three actions", async () => {
    const { scope, handlers } = makeWorkerScope();
    (scope as { maxActions?: number }).maxActions = 3;
    installPushWorkerHandlers(scope);
    await dispatchPush(handlers, reminderPayload("must:2026-11-26:4"));
    const options = vi.mocked(scope.registration.showNotification).mock
      .calls[0]![1] as { actions: { action: string }[] };
    expect(options.actions.map((a) => a.action)).toEqual(["done", "snooze", "skip"]);
  });

  it("ignores unknown types; malformed reminders get the generic notification, never item data", async () => {
    const { scope, handlers } = makeWorkerScope();
    installPushWorkerHandlers(scope);
    await dispatchPush(handlers, { type: "other", title: "x", body: "y" });
    const show = vi.mocked(scope.registration.showNotification);
    expect(show).not.toHaveBeenCalled();

    await dispatchPush(handlers, reminderPayload("must:1", { url: "https://evil.example/" }));
    await dispatchPush(handlers, reminderPayload("must:1", { url: "//evil.example/" }));
    await dispatchPush(handlers, reminderPayload("bad key!"));
    await dispatchPush(handlers, reminderPayload("must:1", { dayKey: "today" }));
    expect(show).toHaveBeenCalledTimes(4);
    for (const call of show.mock.calls) {
      expect(call[0]).toBe("Pulse reminder");
      expect(call[1]).toMatchObject({ data: { kind: "reminder-generic" }, actions: [] });
    }
  });

  it("posts each action with the token to the configured endpoint", async () => {
    const { scope, handlers } = makeWorkerScope();
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    installPushWorkerHandlers(scope, fetcher);
    await configureWorker(handlers, actionEndpoint);
    const data = {
      kind: "reminder",
      itemKey: "must:2026-11-26:4",
      dayKey: "2026-11-26",
      url: "/?focus=must%3A2026-11-26%3A4",
      actionToken: "user.123.sig",
    };

    for (const action of ["done", "snooze", "skip", "attended", "missed"]) {
      await dispatchClick(handlers, action, data);
    }
    await dispatchClick(handlers, "unknown", data);

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      actionEndpoint,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { apikey, "Content-Type": "application/json" },
        body: JSON.stringify({
          actionToken: "user.123.sig",
          itemKey: "must:2026-11-26:4",
          dayKey: "2026-11-26",
          action: "skip",
        }),
      }),
    );
  });

  it("does nothing for an action without a token or configuration", async () => {
    const { scope, handlers } = makeWorkerScope();
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    installPushWorkerHandlers(scope, fetcher);
    const data = {
      kind: "reminder",
      itemKey: "must:2026-11-26:4",
      dayKey: "2026-11-26",
      url: "/",
      actionToken: "user.123.sig",
    };
    await dispatchClick(handlers, "done", data); // not configured yet
    await configureWorker(handlers, actionEndpoint);
    await dispatchClick(handlers, "done", { ...data, actionToken: undefined });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("opens or navigates the app to the focused item on a body tap", async () => {
    const { scope, handlers } = makeWorkerScope();
    const openedWindow = { url: "", navigate: vi.fn(), focus: vi.fn(async () => undefined) };
    vi.mocked(scope.clients.openWindow).mockResolvedValue(openedWindow);
    installPushWorkerHandlers(scope);
    const data = {
      kind: "reminder",
      itemKey: "must:2026-11-26:4",
      dayKey: "2026-11-26",
      url: "/?focus=must%3A2026-11-26%3A4",
    };

    await dispatchClick(handlers, "", data);
    expect(scope.clients.openWindow).toHaveBeenCalledWith(
      "https://pulse.example/?focus=must%3A2026-11-26%3A4",
    );

    const openClient = {
      url: "https://pulse.example/",
      navigate: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    vi.mocked(scope.clients.matchAll).mockResolvedValue([
      openClient,
    ] as unknown as Awaited<ReturnType<typeof scope.clients.matchAll>>);
    await dispatchClick(handlers, "", data);
    expect(openClient.navigate).toHaveBeenCalledWith(
      "https://pulse.example/?focus=must%3A2026-11-26%3A4",
    );
    expect(openClient.focus).toHaveBeenCalledOnce();
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

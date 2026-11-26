export const NOTIFICATION_ACTION_PATH = "/functions/v1/notification-action";
export const NOTIFICATION_TEST_HASH = "#test-push";

export interface NotificationPanelFocusTarget {
  focus(options?: FocusOptions): void;
}

export function focusNotificationPanel(
  panel: NotificationPanelFocusTarget | null,
  hash: string,
): void {
  if (hash === NOTIFICATION_TEST_HASH) {
    panel?.focus({ preventScroll: true });
  }
}

export interface PushSubscriptionRecord {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface BrowserPushSubscription {
  endpoint: string;
  toJSON(): {
    keys?: {
      p256dh?: string;
      auth?: string;
    };
  };
}

interface BrowserPushManager {
  getSubscription(): Promise<BrowserPushSubscription | null>;
  subscribe(options: {
    userVisibleOnly: true;
    applicationServerKey: BufferSource;
  }): Promise<BrowserPushSubscription>;
}

export interface EnrollPushDependencies {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  pushManager: BrowserPushManager;
  userId: string;
  vapidPublicKey: string;
  upsert(record: PushSubscriptionRecord): Promise<string>;
}

export type EnrollPushResult =
  { status: "denied" } | { status: "granted"; subscriptionId: string };

const PUSH_STAGE_TIMEOUT_MS = 10_000;
const PUSH_PERMISSION_TIMEOUT_MS = 30_000;

export function runPushStage<T>(
  start: () => T | PromiseLike<T>,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  let operation: Promise<T>;
  try {
    operation = Promise.resolve(start());
  } catch {
    return Promise.reject(new Error(errorMessage));
  }

  let timeoutId!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  return Promise.race([
    operation.catch(() => {
      throw new Error(errorMessage);
    }),
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}

export function requestPushPermission(
  permission: NotificationPermission,
  requestPermission: () => Promise<NotificationPermission>,
): Promise<NotificationPermission> {
  if (permission !== "default") return Promise.resolve(permission);
  return runPushStage(
    requestPermission,
    PUSH_PERMISSION_TIMEOUT_MS,
    "The browser permission prompt did not finish. Check notification settings, then retry.",
  );
}

export function decodeApplicationServerKey(encoded: string): Uint8Array {
  const normalized = encoded.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("Invalid VAPID public key");
  }

  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.length === 0) throw new Error("Invalid VAPID public key");
  return bytes;
}

export async function enrollPushSubscription(
  dependencies: EnrollPushDependencies,
): Promise<EnrollPushResult> {
  const permission = await requestPushPermission(
    dependencies.permission,
    dependencies.requestPermission,
  );
  if (permission !== "granted") return { status: "denied" };

  const applicationServerKey = decodeApplicationServerKey(
    dependencies.vapidPublicKey,
  );
  const existing = await runPushStage(
    () => dependencies.pushManager.getSubscription(),
    PUSH_STAGE_TIMEOUT_MS,
    "Could not check for an existing browser subscription. Retry push setup.",
  );
  const subscription =
    existing ??
    (await runPushStage(
      () =>
        dependencies.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
        }),
      PUSH_STAGE_TIMEOUT_MS,
      "The browser could not create a push subscription. Check notification settings and retry.",
    ));
  const keys = subscription.toJSON().keys;
  if (
    !subscription.endpoint ||
    typeof keys?.p256dh !== "string" ||
    !keys.p256dh ||
    typeof keys.auth !== "string" ||
    !keys.auth
  ) {
    throw new Error("Browser returned an incomplete push subscription");
  }

  const record: PushSubscriptionRecord = {
    user_id: dependencies.userId,
    endpoint: subscription.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  };
  const subscriptionId = await runPushStage(
    () => dependencies.upsert(record),
    PUSH_STAGE_TIMEOUT_MS,
    "Could not save the push subscription. Check your connection and retry.",
  );
  if (!subscriptionId) throw new Error("Could not save push subscription");
  return { status: "granted", subscriptionId };
}

export function createNotificationActionEndpoint(supabaseUrl: string): string {
  let supabase: URL;
  try {
    supabase = new URL(supabaseUrl);
  } catch {
    throw new Error("Invalid Supabase URL");
  }
  if (
    (supabase.protocol !== "https:" &&
      !(supabase.protocol === "http:" && isLocalhost(supabase.hostname))) ||
    supabase.username ||
    supabase.password ||
    supabase.search ||
    supabase.hash
  ) {
    throw new Error("Invalid Supabase URL");
  }
  return new URL(NOTIFICATION_ACTION_PATH, supabase.origin).href;
}

export interface PushWorkerConfiguration {
  actionEndpoint: string;
  apikey: string;
}

export interface PushWorkerMessenger {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

export async function configurePushWorker(
  worker: PushWorkerMessenger,
  configuration: PushWorkerConfiguration,
): Promise<void> {
  validateWorkerConfiguration(configuration);
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      channel.port2.close();
      reject(
        new Error(
          "Pulse service worker did not respond to push setup. Refresh the app and retry.",
        ),
      );
    }, 5000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      clearTimeout(timeout);
      channel.port1.close();
      const result = event.data as { ok?: unknown } | null;
      if (result?.ok === true) resolve();
      else {
        reject(
          new Error(
            "Pulse service worker could not save push settings. Refresh the app and retry.",
          ),
        );
      }
    };
    try {
      worker.postMessage({ type: "pulse-push-config", ...configuration }, [
        channel.port2,
      ]);
    } catch {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      reject(
        new Error(
          "Pulse service worker could not receive push settings. Refresh the app and retry.",
        ),
      );
    }
  });
}

/**
 * Re-sends the worker configuration when this device already has a push
 * subscription. Returns true when the worker was configured.
 */
export async function refreshPushWorkerConfiguration(
  registration: {
    active: PushWorkerMessenger | null;
    pushManager: { getSubscription(): Promise<unknown> };
  },
  configuration: PushWorkerConfiguration,
): Promise<boolean> {
  const existing = await registration.pushManager.getSubscription();
  if (!existing || !registration.active) return false;
  await configurePushWorker(registration.active, configuration);
  return true;
}

export async function sendTestPush(
  input: {
    supabaseUrl: string;
    apikey: string;
    accessToken: string;
    subscriptionId: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  let endpoint: string;
  try {
    const base = new URL(input.supabaseUrl);
    if (
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && isLocalhost(base.hostname))) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      return false;
    }
    endpoint = new URL("/functions/v1/send-test-push", base.origin).href;
  } catch {
    return false;
  }

  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        apikey: input.apikey,
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subscriptionId: input.subscriptionId }),
      redirect: "error",
    });
    if (!response.ok) return false;
    const body: unknown = await response.json().catch(() => null);
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      (body as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
}

interface PushNotificationOptions {
  body: string;
  data: unknown;
  actions: Array<{ action: string; title: string }>;
  tag: string;
  renotify?: boolean;
}

export type ReminderActionName = "done" | "snooze" | "skip" | "attended" | "missed";

export interface ReminderNotificationAction {
  action: ReminderActionName;
  title: string;
}

const ACTION_DONE: ReminderNotificationAction = { action: "done", title: "Done" };
const ACTION_SNOOZE: ReminderNotificationAction = {
  action: "snooze",
  title: "Snooze 10 min",
};
const ACTION_SKIP: ReminderNotificationAction = { action: "skip", title: "Skip" };
const REMINDER_ACTION_NAMES = new Set<string>([
  "done",
  "snooze",
  "skip",
  "attended",
  "missed",
]);

/**
 * Buttons per reminder kind, decided from the item key. Must-do items get Done and
 * Snooze (plus Skip where the platform shows 3 or more actions), nudges get Done,
 * attendance prompts get Attended / Missed, timetable alerts and water get none.
 */
export function reminderActionsFor(
  itemKey: string,
  maxActions = 2,
): ReminderNotificationAction[] {
  if (itemKey.startsWith("alert:") || itemKey.startsWith("water:")) return [];
  if (itemKey.endsWith(":attendance")) {
    return [
      { action: "attended", title: "Attended" },
      { action: "missed", title: "Missed" },
    ];
  }
  if (itemKey.startsWith("habit:")) return [ACTION_DONE];
  return maxActions >= 3
    ? [ACTION_DONE, ACTION_SNOOZE, ACTION_SKIP]
    : [ACTION_DONE, ACTION_SNOOZE];
}

interface PushWorkerCache {
  put(request: string, response: Response): Promise<void>;
  match(request: string): Promise<Response | undefined>;
}

interface PushWindowClient {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
}

export interface PushWorkerScope {
  /** Override for tests; defaults to `Notification.maxActions`, else 2. */
  maxActions?: number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  caches: {
    open(name: string): Promise<PushWorkerCache>;
  };
  location: { origin: string };
  registration: {
    showNotification(
      title: string,
      options: PushNotificationOptions,
    ): Promise<void>;
  };
  clients: {
    matchAll(options: {
      type: "window";
      includeUncontrolled: true;
    }): Promise<PushWindowClient[]>;
    openWindow(url: string): Promise<PushWindowClient | null>;
  };
}

interface WorkerConfigurationMessage extends PushWorkerConfiguration {
  type: "pulse-push-config";
}

interface WorkerEvent {
  action?: string;
  data?: { json(): unknown } | unknown;
  notification?: { close(): void; data?: unknown };
  ports?: Array<{ postMessage(message: unknown): void }>;
  waitUntil?(promise: Promise<unknown>): void;
}

interface TestPushPayload {
  type: "pulse-test";
  notificationId: string;
  capability: string;
  actionEndpoint: string;
  title: string;
  body: string;
}

interface ReminderPushPayload {
  type: "pulse-reminder";
  title: string;
  body: string;
  tag: string;
  data: {
    itemKey: string;
    dayKey: string;
    url: string;
    actionToken?: string;
  };
}

type PushPayload = TestPushPayload | ReminderPushPayload;

const workerConfigCache = "pulse-push-worker-config-v1";
const workerConfigPath = "/__pulse_push_worker_config__";

export function installPushWorkerHandlers(
  scope: PushWorkerScope,
  fetcher: typeof fetch = fetch,
): void {
  scope.addEventListener("message", (rawEvent) => {
    const event = rawEvent as WorkerEvent;
    const data = event.data as Partial<WorkerConfigurationMessage> | null;
    if (data?.type !== "pulse-push-config") return;

    const save = saveWorkerConfiguration(scope, {
      actionEndpoint: data.actionEndpoint ?? "",
      apikey: data.apikey ?? "",
    })
      .then(() => event.ports?.[0]?.postMessage({ ok: true }))
      .catch(() => event.ports?.[0]?.postMessage({ ok: false }));
    event.waitUntil?.(save);
  });

  scope.addEventListener("push", (rawEvent) => {
    const event = rawEvent as WorkerEvent;
    const payload = readPushPayload(event.data);
    if (!payload) {
      // A malformed reminder must still alert: show a generic notification
      // (no item data, no actions) that opens the app.
      if (isReminderPushType(event.data)) {
        event.waitUntil?.(
          scope.registration.showNotification("Pulse reminder", {
            body: "Open Pulse to see what is due.",
            data: { kind: "reminder-generic" },
            actions: [],
            tag: "pulse-reminder-generic",
            renotify: true,
          }),
        );
      }
      return;
    }
    if (payload.type === "pulse-reminder") {
      const { itemKey, dayKey, url, actionToken } = payload.data;
      const actions = actionToken
        ? reminderActionsFor(itemKey, platformMaxActions(scope))
        : [];
      event.waitUntil?.(
        scope.registration.showNotification(payload.title, {
          body: payload.body,
          data: { kind: "reminder", itemKey, dayKey, url, actionToken },
          actions,
          tag: payload.tag,
          // Reminders repeat under the same tag: alert again each time.
          renotify: true,
        }),
      );
      return;
    }
    event.waitUntil?.(
      scope.registration.showNotification(payload.title, {
        body: payload.body,
        data: {
          notificationId: payload.notificationId,
          capability: payload.capability,
          actionEndpoint: payload.actionEndpoint,
        },
        actions: [
          { action: "done", title: "Done" },
          { action: "snooze", title: "Snooze 10 min" },
        ],
        tag: `pulse-${payload.notificationId}`,
      }),
    );
  });

  scope.addEventListener("notificationclick", (rawEvent) => {
    const event = rawEvent as WorkerEvent;
    event.notification?.close();
    const rawData = event.notification?.data as { kind?: unknown } | null;
    if (rawData?.kind === "reminder-generic") {
      if (!event.action) event.waitUntil?.(openClientAt(scope, "/"));
      return;
    }
    const reminder = readReminderNotificationData(event.notification?.data);
    if (reminder) {
      if (event.action && REMINDER_ACTION_NAMES.has(event.action)) {
        event.waitUntil?.(
          postReminderAction(
            scope,
            reminder,
            event.action as ReminderActionName,
            fetcher,
          ),
        );
      } else if (!event.action) {
        event.waitUntil?.(openClientAt(scope, reminder.url));
      }
      return;
    }
    const data = readNotificationData(event.notification?.data);
    if (event.action === "done" || event.action === "snooze") {
      if (!data) return;
      event.waitUntil?.(
        postNotificationAction(scope, data, event.action, fetcher),
      );
      return;
    }

    if (!event.action) {
      event.waitUntil?.(openClientAt(scope, `/${NOTIFICATION_TEST_HASH}`));
    }
  });
}

async function saveWorkerConfiguration(
  scope: PushWorkerScope,
  configuration: PushWorkerConfiguration,
): Promise<void> {
  validateWorkerConfiguration(configuration);
  const cache = await scope.caches.open(workerConfigCache);
  await cache.put(
    new URL(workerConfigPath, scope.location.origin).href,
    new Response(JSON.stringify(configuration), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function validateWorkerConfiguration(
  configuration: PushWorkerConfiguration,
): void {
  if (
    !isActionEndpoint(configuration.actionEndpoint) ||
    typeof configuration.apikey !== "string" ||
    !configuration.apikey.trim()
  ) {
    throw new Error("Invalid push worker configuration");
  }
}

function isActionEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.href === endpoint &&
      url.pathname === NOTIFICATION_ACTION_PATH &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLocalhost(url.hostname)))
    );
  } catch {
    return false;
  }
}

async function readWorkerConfiguration(
  scope: PushWorkerScope,
): Promise<PushWorkerConfiguration | null> {
  const cache = await scope.caches.open(workerConfigCache);
  const response = await cache.match(
    new URL(workerConfigPath, scope.location.origin).href,
  );
  if (!response) return null;
  const value: unknown = await response.json().catch(() => null);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const configuration = value as Partial<PushWorkerConfiguration>;
  if (
    typeof configuration.actionEndpoint !== "string" ||
    typeof configuration.apikey !== "string"
  ) {
    return null;
  }
  try {
    validateWorkerConfiguration(configuration as PushWorkerConfiguration);
    return configuration as PushWorkerConfiguration;
  } catch {
    return null;
  }
}

function isReminderPushType(data: WorkerEvent["data"]): boolean {
  if (!data || typeof data !== "object" || !("json" in data)) return false;
  try {
    const value = (data as { json(): unknown }).json();
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "pulse-reminder"
    );
  } catch {
    return false;
  }
}

function readPushPayload(data: WorkerEvent["data"]): PushPayload | null {
  if (!data || typeof data !== "object" || !("json" in data)) return null;
  let value: unknown;
  try {
    value = (data as { json(): unknown }).json();
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if ((value as { type?: unknown }).type === "pulse-reminder") {
    return readReminderPayload(value as Record<string, unknown>);
  }
  const payload = value as Partial<TestPushPayload>;
  if (
    payload.type !== "pulse-test" ||
    !isUuid(payload.notificationId) ||
    !isCapability(payload.capability) ||
    typeof payload.actionEndpoint !== "string" ||
    !isActionEndpoint(payload.actionEndpoint) ||
    typeof payload.title !== "string" ||
    typeof payload.body !== "string"
  ) {
    return null;
  }
  return payload as TestPushPayload;
}

const ITEM_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,120}$/;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isAppPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    /^\/(?![/\\])[^\s]*$/.test(value)
  );
}

function readReminderPayload(
  payload: Record<string, unknown>,
): ReminderPushPayload | null {
  const data = payload.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const { itemKey, dayKey, url, actionToken } = data as Record<string, unknown>;
  if (
    typeof payload.title !== "string" ||
    typeof payload.body !== "string" ||
    typeof itemKey !== "string" ||
    !ITEM_KEY_PATTERN.test(itemKey) ||
    typeof dayKey !== "string" ||
    !DAY_KEY_PATTERN.test(dayKey) ||
    !isAppPath(url) ||
    (actionToken !== undefined &&
      (typeof actionToken !== "string" || actionToken.length > 300))
  ) {
    return null;
  }
  return {
    type: "pulse-reminder",
    title: payload.title,
    body: payload.body,
    tag: typeof payload.tag === "string" && payload.tag ? payload.tag : itemKey,
    data: {
      itemKey,
      dayKey,
      url,
      ...(actionToken === undefined ? {} : { actionToken }),
    },
  };
}

interface ReminderNotificationData {
  itemKey: string;
  dayKey: string;
  url: string;
  actionToken?: string;
}

function readReminderNotificationData(
  data: unknown,
): ReminderNotificationData | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const value = data as Record<string, unknown>;
  if (
    value.kind !== "reminder" ||
    typeof value.itemKey !== "string" ||
    !ITEM_KEY_PATTERN.test(value.itemKey) ||
    typeof value.dayKey !== "string" ||
    !DAY_KEY_PATTERN.test(value.dayKey) ||
    !isAppPath(value.url)
  ) {
    return null;
  }
  return {
    itemKey: value.itemKey,
    dayKey: value.dayKey,
    url: value.url,
    ...(typeof value.actionToken === "string"
      ? { actionToken: value.actionToken }
      : {}),
  };
}

function platformMaxActions(scope: PushWorkerScope): number {
  if (typeof scope.maxActions === "number") return scope.maxActions;
  const max = (globalThis as { Notification?: { maxActions?: unknown } })
    .Notification?.maxActions;
  return typeof max === "number" ? max : 2;
}

async function postReminderAction(
  scope: PushWorkerScope,
  data: ReminderNotificationData,
  action: ReminderActionName,
  fetcher: typeof fetch,
): Promise<void> {
  if (!data.actionToken) return;
  const configuration = await readWorkerConfiguration(scope);
  if (!configuration) return;
  try {
    await fetcher(configuration.actionEndpoint, {
      method: "POST",
      headers: {
        apikey: configuration.apikey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actionToken: data.actionToken,
        itemKey: data.itemKey,
        dayKey: data.dayKey,
        action,
      }),
      redirect: "error",
    });
  } catch {
    // Tokens and item keys must never be copied into logs or URLs.
  }
}

interface NotificationActionData {
  notificationId: string;
  capability: string;
  actionEndpoint: string;
}

function readNotificationData(data: unknown): NotificationActionData | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const value = data as Partial<NotificationActionData>;
  if (
    !isUuid(value.notificationId) ||
    !isCapability(value.capability) ||
    typeof value.actionEndpoint !== "string" ||
    !isActionEndpoint(value.actionEndpoint)
  ) {
    return null;
  }
  return value as NotificationActionData;
}

async function postNotificationAction(
  scope: PushWorkerScope,
  data: NotificationActionData,
  action: "done" | "snooze",
  fetcher: typeof fetch,
): Promise<void> {
  const configuration = await readWorkerConfiguration(scope);
  if (!configuration || data.actionEndpoint !== configuration.actionEndpoint) {
    return;
  }
  try {
    await fetcher(configuration.actionEndpoint, {
      method: "POST",
      headers: {
        apikey: configuration.apikey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        notificationId: data.notificationId,
        action,
        capability: data.capability,
      }),
      redirect: "error",
    });
  } catch {
    // Notification capabilities must never be copied into logs or URLs.
  }
}

async function openClientAt(
  scope: PushWorkerScope,
  path: string,
): Promise<void> {
  const target = new URL(path, scope.location.origin);
  const clients = await scope.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const current =
    clients.find((client) => client.url === target.href) ??
    clients.find((client) => {
      try {
        return new URL(client.url).origin === scope.location.origin;
      } catch {
        return false;
      }
    });
  if (current) {
    if (current.url !== target.href) await current.navigate(target.href);
    await current.focus();
  } else {
    const opened = await scope.clients.openWindow(target.href);
    await opened?.focus();
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isCapability(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isLocalhost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

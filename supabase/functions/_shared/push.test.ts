import { describe, expect, it, vi } from "vitest";
import {
  handleNotificationActionRequest,
  isAllowedPushEndpoint,
  postEncryptedPush,
} from "./push.ts";

const notificationId = "8b4df36e-8ef6-4a3b-a3c3-49de1b696920";
const token = "A".repeat(43);

function actionRequest(action: string, capability = token) {
  return new Request("https://pulse.example/functions/v1/notification-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notificationId, action, capability }),
  });
}

describe("push endpoint validation", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/token",
    "https://fcm.googleapis.com/fcm/send/token%3Dpart",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://web.push.apple.com/Qtoken",
  ])("allows known push service %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/token",
    "https://attacker.example/fcm/send/token",
    "https://fcm.googleapis.com.attacker.example/fcm/send/token",
    "https://user@fcm.googleapis.com/fcm/send/token",
    "https://fcm.googleapis.com:8443/fcm/send/token",
    "not a URL",
  ])("rejects untrusted push endpoint %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

describe("encrypted push transport", () => {
  it("posts only to the validated endpoint and refuses redirects", async () => {
    let requestUrl: RequestInfo | URL | undefined;
    let requestInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      requestUrl = input;
      requestInit = init;
      return new Response(null, { status: 201 });
    };
    const encrypted = {
      endpoint: "https://fcm.googleapis.com/fcm/send/token",
      headers: { "Content-Encoding": "aes128gcm" },
      body: new Uint8Array([1, 2, 3]),
    };

    const response = await postEncryptedPush(encrypted, fetcher);

    expect(response.status).toBe(201);
    expect(requestUrl).toBe(encrypted.endpoint);
    expect(requestInit).toMatchObject({ method: "POST", redirect: "error" });
    expect(requestInit?.body).toBe(encrypted.body);
  });

  it("never calls fetch for an untrusted encrypted endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      postEncryptedPush(
        {
          endpoint: "https://attacker.example/push",
          headers: {},
          body: new Uint8Array(),
        },
        fetcher,
      ),
    ).rejects.toThrow("Unsupported push endpoint");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("notification action callback", () => {
  it("applies an action with the hashed capability and returns the persisted result", async () => {
    const apply = vi.fn().mockResolvedValue({
      action: "snooze",
      snoozed_until: "2026-11-26T12:10:00.000Z",
      idempotent: false,
    });

    const response = await handleNotificationActionRequest(
      actionRequest("snooze"),
      { apply },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      notificationId,
      action: "snooze",
      snoozedUntil: "2026-11-26T12:10:00.000Z",
      idempotent: false,
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId, action: "snooze" }),
    );
    expect(apply.mock.calls[0]?.[0].capabilityHash).not.toBe(token);
  });

  it.each([
    ["invalid action", { notificationId, action: "delete", capability: token }],
    [
      "invalid id",
      { notificationId: "not-a-uuid", action: "done", capability: token },
    ],
    ["missing capability", { notificationId, action: "done" }],
    [
      "malformed capability",
      { notificationId, action: "done", capability: "short" },
    ],
  ])("rejects %s before storage access", async (_label, body) => {
    const apply = vi.fn();
    const request = new Request(
      "https://pulse.example/functions/v1/notification-action",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const response = await handleNotificationActionRequest(request, { apply });

    expect(response.status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects an expired or unknown capability", async () => {
    const apply = vi.fn().mockResolvedValue(null);
    const response = await handleNotificationActionRequest(
      actionRequest("done"),
      {
        apply,
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Invalid or expired action",
    });
  });

  it("returns an idempotent success for repeated identical actions", async () => {
    const apply = vi.fn().mockResolvedValue({
      action: "done",
      snoozed_until: null,
      idempotent: true,
    });
    const response = await handleNotificationActionRequest(
      actionRequest("done"),
      {
        apply,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: "done",
      idempotent: true,
    });
  });

  it("rejects a different action after the notification was already handled", async () => {
    const apply = vi.fn().mockResolvedValue({
      action: "done",
      snoozed_until: null,
      idempotent: false,
    });
    const response = await handleNotificationActionRequest(
      actionRequest("snooze"),
      {
        apply,
      },
    );

    expect(response.status).toBe(409);
  });
});

import { encrypt, generateVapidKey } from "jsr:@daaku/webpush@0.2.0";
import { encodeBase64Url, postEncryptedPush } from "./push.ts";

Deno.test(
  "Web Push encryption creates an aes128gcm VAPID request",
  async () => {
    const clientKeys = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const publicPoint = new Uint8Array(
      await crypto.subtle.exportKey("raw", clientKeys.publicKey),
    );
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
      keys: {
        p256dh: encodeBase64Url(publicPoint),
        auth: encodeBase64Url(authSecret),
      },
    };

    const encrypted = await encrypt(
      subscription,
      JSON.stringify({ title: "Pulse push test" }),
      {
        vapid: await generateVapidKey(),
        subscriber: "mailto:push-test@example.invalid",
        ttl: 60,
      },
    );

    const header = (name: string) =>
      Object.entries(encrypted.headers).find(
        ([key]) => key.toLowerCase() === name.toLowerCase(),
      )?.[1];
    if (encrypted.endpoint !== subscription.endpoint) {
      throw new Error("Encryption changed the push endpoint");
    }
    if (header("content-encoding") !== "aes128gcm") {
      throw new Error("Encrypted request is missing aes128gcm encoding");
    }
    if (!header("authorization") || encrypted.body.byteLength <= 16) {
      throw new Error("Encrypted VAPID request is incomplete");
    }

    let sentRequest: RequestInit | undefined;
    const response = await postEncryptedPush(
      encrypted,
      async (_input, init) => {
        sentRequest = init;
        return new Response(null, { status: 201 });
      },
    );
    if (response.status !== 201 || sentRequest?.redirect !== "error") {
      throw new Error(
        "Push transport did not send the encrypted request safely",
      );
    }
  },
);

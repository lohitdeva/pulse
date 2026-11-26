import { useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  configurePushWorker,
  createNotificationActionEndpoint,
  enrollPushSubscription,
  focusNotificationPanel,
  sendTestPush,
} from "./push";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim();

interface PushSettingsProps {
  client: SupabaseClient;
  userId: string;
}

export function PushSettings({ client, userId }: PushSettingsProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [subscriptionId, setSubscriptionId] = useState("");
  const [enabling, setEnabling] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const focusPanelFromHash = () =>
      focusNotificationPanel(panelRef.current, window.location.hash);
    focusPanelFromHash();
    window.addEventListener("hashchange", focusPanelFromHash);
    return () => window.removeEventListener("hashchange", focusPanelFromHash);
  }, []);

  async function handleEnable() {
    setError("");
    setMessage("");
    setEnabling(true);

    try {
      if (
        !("Notification" in window) ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)
      ) {
        throw new Error("Push notifications are not supported by this browser.");
      }
      if (!supabaseUrl || !supabaseKey || !vapidPublicKey) {
        throw new Error("Push is not configured for this deployment.");
      }

      const registration = await navigator.serviceWorker.ready;
      if (!registration.active) {
        throw new Error("Pulse service worker is not ready yet.");
      }

      const enrollment = await enrollPushSubscription({
        permission: Notification.permission,
        requestPermission: () => Notification.requestPermission(),
        pushManager: registration.pushManager,
        userId,
        vapidPublicKey,
        async upsert(record) {
          const { data, error: saveError } = await client
            .from("push_subscriptions")
            .upsert(record, { onConflict: "user_id,endpoint" })
            .select("id")
            .single();
          if (saveError || !data?.id) {
            throw new Error("Could not save push subscription.");
          }
          return data.id as string;
        },
      });

      if (enrollment.status === "denied") {
        setMessage("Notifications are blocked in browser settings.");
        return;
      }

      await configurePushWorker(registration.active, {
        actionEndpoint: createNotificationActionEndpoint(supabaseUrl),
        apikey: supabaseKey,
      });
      setSubscriptionId(enrollment.subscriptionId);
      setMessage("Push is enabled. Send a test notification to confirm delivery.");
    } catch {
      setError(
        "Could not enable push. Check the app configuration and try again.",
      );
    } finally {
      setEnabling(false);
    }
  }

  async function handleSendTest() {
    setError("");
    setMessage("");
    setSending(true);

    try {
      if (!supabaseUrl || !supabaseKey || !subscriptionId) {
        throw new Error("Push is not ready to test.");
      }
      const {
        data: { session },
        error: sessionError,
      } = await client.auth.getSession();
      if (sessionError || !session?.access_token) {
        throw new Error("A signed-in session is required.");
      }

      const sent = await sendTestPush({
        supabaseUrl,
        apikey: supabaseKey,
        accessToken: session.access_token,
        subscriptionId,
      });
      if (!sent) throw new Error("The test notification could not be sent.");
      setMessage("Test notification sent. Check this device.");
    } catch {
      setError("Could not send a test notification. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      aria-labelledby="push-settings-title"
      className="push-settings"
      id="test-push"
      ref={panelRef}
      tabIndex={-1}
    >
      <p className="eyebrow">SETTINGS</p>
      <h2 id="push-settings-title">Notifications</h2>
      <p className="push-settings-copy">
        Enable push on this device, then send a test notification.
      </p>
      <div className="push-settings-actions">
        <button
          className="button button-primary"
          disabled={enabling}
          onClick={() => void handleEnable()}
          type="button"
        >
          {enabling ? "Enabling…" : "Enable push on this device"}
        </button>
        <button
          className="button push-test-button"
          disabled={!subscriptionId || sending}
          onClick={() => void handleSendTest()}
          type="button"
        >
          {sending ? "Sending…" : "Send test notification"}
        </button>
      </div>
      {message ? (
        <p role="status" className="push-settings-copy">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="push-settings-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

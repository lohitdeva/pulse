import { createClient, type Session } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent } from "react";
import { PushSettings } from "./PushSettings";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: true,
          detectSessionInUrl: true,
          persistSession: true,
        },
      })
    : null;

function cleanAuthCallbackUrl() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const callbackKeys = [
    "code",
    "error",
    "error_code",
    "error_description",
    "token_hash",
    "type",
  ];
  const hasAuthCallback =
    callbackKeys.some((key) => url.searchParams.has(key)) ||
    [
      "access_token",
      "refresh_token",
      "expires_in",
      "token_type",
      "type",
      "error_description",
    ].some((key) => hash.has(key));

  if (!hasAuthCallback) return;

  for (const key of callbackKeys) url.searchParams.delete(key);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url.toString());
}

export function Auth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    let active = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession);
    });

    void supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (!active) return;
        if (sessionError)
          setError(
            "Pulse could not restore your local session. Try refreshing.",
          );
        setSession(data.session);
        cleanAuthCallbackUrl();
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setError("Pulse could not restore your local session. Try refreshing.");
        setLoading(false);
      });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    setError("");
    setMessage("");
    setSending(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          shouldCreateUser: false,
          emailRedirectTo: window.location.origin,
        },
      });

      if (signInError) {
        setError(
          "Could not send a sign-in link. Check that local Supabase is running and try again.",
        );
      } else {
        setMessage(
          "If this address has a Pulse account, a sign-in link is on its way.",
        );
      }
    } catch {
      setError(
        "Could not send a sign-in link. Check that local Supabase is running and try again.",
      );
    } finally {
      setSending(false);
    }
  }

  async function handleSignOut() {
    if (!supabase) return;
    setError("");
    setSigningOut(true);
    try {
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) setError("Could not sign out. Try again.");
    } catch {
      setError("Could not sign out. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  const missingConfig = !supabaseUrl || !supabaseKey;

  return (
    <main className="home-shell">
      <section className="home-card" aria-labelledby="home-title">
        <p className="eyebrow">YOUR DAILY SIGNAL</p>
        <h1 id="home-title">Pulse</h1>
        <p className="home-copy">A calmer way to see how your day is going.</p>

        {missingConfig ? (
          <p role="status" className="home-copy">
            Local sign-in is not configured yet. Set VITE_SUPABASE_URL and
            VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY) in the
            repository root .env.local file.
          </p>
        ) : loading ? (
          <p role="status" className="home-copy">
            Restoring your session…
          </p>
        ) : session && supabase ? (
          <div className="grid gap-4">
            <p className="home-copy">You are signed in.</p>
            <PushSettings client={supabase} userId={session.user.id} />
            <button
              className="button button-primary"
              disabled={signingOut}
              onClick={() => void handleSignOut()}
              type="button"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event) => void handleSubmit(event)}
          >
            <label className="grid gap-2 text-sm" htmlFor="email">
              Email address
              <input
                autoComplete="email"
                className="min-h-11 rounded-xl border border-[var(--pulse-border)] bg-[var(--pulse-surface-raised)] px-3 text-[var(--pulse-text)]"
                id="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <button
              className="button button-primary"
              disabled={sending}
              type="submit"
            >
              {sending ? "Sending link…" : "Email me a sign-in link"}
            </button>
            {message ? (
              <p role="status" className="home-copy">
                {message}
              </p>
            ) : null}
          </form>
        )}

        {error ? (
          <p role="alert" className="home-copy">
            {error}
          </p>
        ) : null}
        <a
          className="button mt-5 border border-[var(--pulse-border)]"
          href="/dev"
        >
          Explore the UI gallery
        </a>
      </section>
    </main>
  );
}

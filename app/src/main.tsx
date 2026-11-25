import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <main className="flex min-h-screen items-center justify-center bg-stone-50 text-stone-900">
    <h1 className="text-4xl font-semibold tracking-tight">Pulse</h1>
  </main>,
);

if (import.meta.env.PROD) {
  registerSW({ immediate: true });
}

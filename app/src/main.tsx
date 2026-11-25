import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { DevGallery } from "./DevGallery";
import "./styles.css";

function App() {
  const isGallery = window.location.pathname.replace(/\/+$/, "") === "/dev";

  if (isGallery) {
    return <DevGallery />;
  }

  return (
    <main className="home-shell">
      <section className="home-card" aria-labelledby="home-title">
        <p className="eyebrow">YOUR DAILY SIGNAL</p>
        <h1 id="home-title">Pulse</h1>
        <p className="home-copy">A calmer way to see how your day is going.</p>
        <a className="button button-primary" href="/dev">
          Explore the UI gallery
        </a>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

if (import.meta.env.PROD) {
  registerSW({ immediate: true });
}

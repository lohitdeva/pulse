import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { Auth } from "./Auth";
import { DevGallery } from "./DevGallery";
import "./styles.css";

function App() {
  const isGallery = window.location.pathname.replace(/\/+$/, "") === "/dev";

  if (isGallery) {
    return <DevGallery />;
  }

  return <Auth />;
}

createRoot(document.getElementById("root")!).render(<App />);

if (import.meta.env.PROD) {
  registerSW({ immediate: true });
}

/**
 * App shell: wires up tab navigation across the four view modules (each
 * loaded as its own <script> before this file) and boots the service worker.
 * Each view module exposes `init()` (called once, builds its DOM/listeners)
 * and optionally `onShow()` (called on every later activation, to refresh
 * data another tab may have changed).
 */
(() => {
  const tabButtons = document.querySelectorAll(".tab-button");
  const views = document.querySelectorAll(".view");
  const appTitle = document.getElementById("app-title");

  const viewModules = {
    log: LogView,
    timeline: TimelineView,
    trends: TrendsView,
    data: DataView,
  };

  const VIEW_TITLES = {
    log: "Log Entry",
    timeline: "Timeline",
    trends: "Trends",
    data: "Export & Import",
  };

  const initialized = new Set();

  /** Shows the named view's section, updates the tab bar + header, and (lazily) inits/refreshes it. */
  function showView(name) {
    views.forEach((view) => {
      const isTarget = view.dataset.view === name;
      view.hidden = !isTarget;
      if (isTarget) {
        // Re-trigger the CSS fade-in animation on every switch, not just the first.
        view.classList.remove("view-active");
        void view.offsetWidth; // force reflow so the animation restarts
        view.classList.add("view-active");
      }
    });

    tabButtons.forEach((btn) => {
      if (btn.dataset.target === name) {
        btn.setAttribute("aria-current", "page");
      } else {
        btn.removeAttribute("aria-current");
      }
    });

    appTitle.textContent = VIEW_TITLES[name] || "Symptom Tracker";

    const mod = viewModules[name];
    if (!mod) return;
    if (!initialized.has(name)) {
      mod.init();
      initialized.add(name);
    } else if (mod.onShow) {
      mod.onShow();
    }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.target));
  });

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.error("Service worker registration failed:", err);
      });
    });
  }

  /** Shown only if IndexedDB fails to open (e.g. some private-browsing modes restrict it). */
  function showStorageError() {
    const banner = document.createElement("p");
    banner.className = "error-banner";
    banner.textContent =
      "Couldn't open local storage on this device. Try reloading, or check Safari's privacy settings for this site.";
    document.body.insertBefore(banner, document.body.firstChild);
  }

  async function main() {
    try {
      await DB.open();
    } catch (err) {
      console.error("Failed to open IndexedDB:", err);
      showStorageError();
      return;
    }
    showView("log");
    registerServiceWorker();
  }

  main();
})();

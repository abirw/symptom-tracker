(() => {
  const tabButtons = document.querySelectorAll(".tab-button");
  const views = document.querySelectorAll(".view");

  const viewModules = {
    log: LogView,
    timeline: TimelineView,
    trends: TrendsView,
    export: ExportView,
  };
  const initialized = new Set();

  function showView(name) {
    views.forEach((view) => {
      view.hidden = view.dataset.view !== name;
    });
    tabButtons.forEach((btn) => {
      if (btn.dataset.target === name) {
        btn.setAttribute("aria-current", "page");
      } else {
        btn.removeAttribute("aria-current");
      }
    });
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

  async function main() {
    await DB.open();
    showView("log");
    registerServiceWorker();
  }

  main();
})();

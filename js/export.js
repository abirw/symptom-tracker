/**
 * Export view: dumps all stored data as JSON (full fidelity) or CSV (for a
 * spreadsheet), handed off via the Web Share API so iOS shows its native
 * share sheet. Falls back to a plain browser download wherever share isn't
 * available (desktop browsers, older Safari, or if the user cancels a share
 * for a reason other than dismissing it).
 */
const ExportView = (() => {
  let container;

  function buildFilename(ext) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `symptom-tracker-export-${stamp}.${ext}`;
  }

  /** Quotes a CSV cell only if it contains a comma, quote, or newline, escaping embedded quotes. */
  function escapeCsvCell(value) {
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function toCsv(entries) {
    const header = ["id", "timestamp", "tags", "condition", "severity", "note"];
    const rows = entries.map((e) => [
      e.id,
      e.timestamp,
      (e.tags || []).join("; "),
      e.condition || "",
      e.severity ?? "",
      e.note || "",
    ]);
    return [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  }

  /** Direct-download fallback: creates a throwaway object URL + <a download> click. */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Hands `blob` to the OS share sheet if the platform supports sharing
   * files, otherwise falls back to a direct download.
   * @returns {Promise<"shared"|"cancelled"|"downloaded">}
   */
  async function shareOrDownload(blob, filename, mimeType) {
    const file = new File([blob], filename, { type: mimeType });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "shared";
      } catch (err) {
        if (err.name === "AbortError") return "cancelled"; // user dismissed the share sheet
        // Any other failure: fall through to the download fallback below.
      }
    }
    downloadBlob(blob, filename);
    return "downloaded";
  }

  async function exportJson() {
    const [entries, tags, conditions] = await Promise.all([
      DB.getAllEntries(),
      DB.getAllTags(),
      DB.getAllConditions(),
    ]);
    const payload = { exportedAt: new Date().toISOString(), entries, tags, conditions };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    return shareOrDownload(blob, buildFilename("json"), "application/json");
  }

  async function exportCsv() {
    const entries = await DB.getAllEntries();
    entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const blob = new Blob([toCsv(entries)], { type: "text/csv" });
    return shareOrDownload(blob, buildFilename("csv"), "text/csv");
  }

  function setStatus(message) {
    const el = container.querySelector("#export-status");
    el.hidden = !message;
    el.textContent = message || "";
  }

  /** Disables `button` and swaps its label while `fn` runs, then reports the outcome via setStatus. */
  async function withStatus(button, workingLabel, fn) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = workingLabel;
    setStatus("");
    try {
      const result = await fn();
      if (result === "shared") setStatus("Shared.");
      else if (result === "downloaded") setStatus("Downloaded.");
    } catch (err) {
      console.error(err);
      setStatus("Export failed — please try again.");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function loadSummary() {
    const entries = await DB.getAllEntries();
    const summaryEl = container.querySelector("#export-summary");
    summaryEl.textContent =
      entries.length === 0
        ? "No entries yet — nothing to export."
        : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} ready to export.`;
  }

  function render() {
    container.innerHTML = `
      <div class="field">
        <p id="export-summary" class="export-summary">Loading…</p>
      </div>
      <div class="export-actions">
        <button type="button" id="export-json-btn" class="primary-btn">Share JSON</button>
        <button type="button" id="export-csv-btn" class="secondary-btn">Share CSV</button>
      </div>
      <p id="export-status" class="confirmation" hidden></p>
      <p class="export-note">
        JSON keeps full fidelity (entries, tags, conditions) for backup. CSV is for opening in a
        spreadsheet. Nothing leaves this device except through this deliberate export action.
      </p>
    `;
  }

  async function init() {
    container = document.getElementById("view-export");
    render();

    container.querySelector("#export-json-btn").addEventListener("click", (e) => {
      withStatus(e.currentTarget, "Preparing…", exportJson);
    });
    container.querySelector("#export-csv-btn").addEventListener("click", (e) => {
      withStatus(e.currentTarget, "Preparing…", exportCsv);
    });

    await loadSummary();
  }

  return { init, onShow: loadSummary };
})();

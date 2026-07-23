/**
 * Data view: Export (JSON/CSV via the iOS share sheet) plus Import, in three
 * flavors:
 *  - Restore a JSON backup (this app's own export format, full fidelity).
 *  - Bulk-import a CSV (this app's own export columns, or a hand-made one
 *    with at least a "timestamp" column).
 *  - Extract entries from a plain-text journal via a local heuristic
 *    (js/importer.js) - never sent anywhere, and always shown as a
 *    review-before-import list since the guesses won't always be right.
 */
const DataView = (() => {
  let container;
  let allTags = [];
  let allConditions = [];
  let pendingStructuredImport = null; // { entries, tags, conditions } awaiting confirmation
  let candidates = []; // text-extraction candidates awaiting review
  let tagUsageCounts = {}; // tag name -> entry count, for the Manage Tags list

  // ---- Export ----

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
    const header = ["id", "timestamp", "tags", "conditions", "severity", "note"];
    const rows = entries.map((e) => [
      e.id,
      e.timestamp,
      (e.tags || []).join("; "),
      (e.conditions || []).join("; "),
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

  async function loadExportSummary() {
    const entries = await DB.getAllEntries();
    const summaryEl = container.querySelector("#export-summary");
    summaryEl.textContent =
      entries.length === 0
        ? "No entries yet — nothing to export."
        : `${entries.length} ${entries.length === 1 ? "entry" : "entries"} ready to export.`;
  }

  // ---- Import: structured (JSON backup or CSV) ----

  async function handleStructuredFile(file) {
    const statusEl = container.querySelector("#import-structured-status");
    const previewEl = container.querySelector("#import-structured-preview");
    previewEl.hidden = true;
    pendingStructuredImport = null;
    statusEl.textContent = "Reading file…";

    try {
      const text = await file.text();
      let entries, tags, conditions;
      if (file.name.toLowerCase().endsWith(".json")) {
        ({ entries, tags, conditions } = Importer.parseJsonBackup(text));
      } else {
        entries = Importer.csvToEntries(text);
        tags = [];
        conditions = [];
      }

      pendingStructuredImport = { entries, tags, conditions };
      statusEl.textContent = "";

      const parts = [`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`];
      if (tags.length) parts.push(`${tags.length} ${tags.length === 1 ? "tag" : "tags"}`);
      if (conditions.length) parts.push(`${conditions.length} ${conditions.length === 1 ? "condition" : "conditions"}`);
      container.querySelector("#import-structured-summary").textContent =
        `Found ${parts.join(", ")}. Importing adds these to what's already stored ` +
        `(entries sharing an id with one you already have are updated, not duplicated).`;
      previewEl.hidden = false;
    } catch (err) {
      console.error(err);
      statusEl.textContent = err.message || "Couldn't read that file.";
    }
  }

  async function confirmStructuredImport() {
    if (!pendingStructuredImport) return;
    const btn = container.querySelector("#import-structured-confirm-btn");
    const statusEl = container.querySelector("#import-structured-status");
    btn.disabled = true;
    btn.textContent = "Importing…";

    try {
      const { entries, tags, conditions } = pendingStructuredImport;

      for (const t of tags) {
        await DB.mergeTagRecord(t);
      }
      for (const c of conditions) {
        await DB.mergeConditionRecord(c);
      }
      for (const e of entries) {
        for (const name of e.tags || []) {
          await DB.touchTag(name, e.timestamp);
        }
        for (const name of e.conditions || []) {
          await DB.touchCondition(name, e.timestamp);
        }
        await DB.updateEntry({ ...e, id: e.id || DB.uuid() });
      }

      statusEl.textContent = `Imported ${entries.length} ${entries.length === 1 ? "entry" : "entries"}.`;
      container.querySelector("#import-structured-preview").hidden = true;
      container.querySelector("#import-structured-file").value = "";
      pendingStructuredImport = null;
      await loadExportSummary();
      await loadPickerData();
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Import failed partway through — check the Timeline for what made it in.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Import";
    }
  }

  // ---- Import: plain-text extraction ----

  async function loadPickerData() {
    [allTags, allConditions] = await Promise.all([DB.getAllTags(), DB.getAllConditions()]);
  }

  async function handleTextFile(file) {
    const statusEl = container.querySelector("#import-text-status");
    candidates = [];
    renderCandidateList();
    statusEl.textContent = "Reading file…";

    try {
      const text = await file.text();
      await loadPickerData(); // make sure tag/condition matching uses the latest lists
      const parsed = Importer.parseTextToCandidates(
        text,
        allTags.map((t) => t.name),
        allConditions.map((c) => c.name)
      );
      candidates = parsed.map((c) => ({
        include: true,
        expanded: false,
        timestamp: c.timestamp,
        tags: new Set(c.tags),
        conditions: new Set(c.conditions),
        severity: c.severity,
        note: c.note,
      }));
      statusEl.textContent = candidates.length
        ? `Found ${candidates.length} possible ${candidates.length === 1 ? "entry" : "entries"}. Review before importing.`
        : "Couldn't find any entries in that file.";
      renderCandidateList();
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Couldn't read that file.";
    }
  }

  function buildCandidateEditor(cand) {
    const wrap = document.createElement("div");
    wrap.className = "import-candidate-editor";

    const tagField = document.createElement("div");
    tagField.className = "field";
    const tagLabel = document.createElement("label");
    tagLabel.textContent = "Tags";
    const tagChips = document.createElement("div");
    tagChips.className = "chip-row";
    tagField.append(tagLabel, tagChips);
    wrap.appendChild(tagField);
    Pickers.renderTagChips(tagChips, allTags, cand.tags, (name) => {
      if (cand.tags.has(name)) cand.tags.delete(name);
      else cand.tags.add(name);
    });

    const condField = document.createElement("div");
    condField.className = "field";
    const condLabel = document.createElement("label");
    condLabel.textContent = "Conditions";
    const condChips = document.createElement("div");
    condChips.className = "chip-row";
    condField.append(condLabel, condChips);
    wrap.appendChild(condField);
    Pickers.renderConditionChips(condChips, allConditions, cand.conditions, (name) => {
      if (cand.conditions.has(name)) cand.conditions.delete(name);
      else cand.conditions.add(name);
    });

    const sevField = document.createElement("div");
    sevField.className = "field";
    const sevLabel = document.createElement("label");
    sevLabel.textContent = "Severity";
    const sevRow = document.createElement("div");
    sevRow.className = "severity-row";
    sevField.append(sevLabel, sevRow);
    wrap.appendChild(sevField);
    Pickers.renderSeverity(
      sevRow,
      () => cand.severity,
      (val) => {
        cand.severity = cand.severity === val ? null : val;
      }
    );

    const timeField = document.createElement("div");
    timeField.className = "field";
    const timeLabel = document.createElement("label");
    timeLabel.textContent = "Time";
    const timeInput = document.createElement("input");
    timeInput.type = "datetime-local";
    timeInput.value = cand.timestamp ? DateUtils.toLocalInputValue(cand.timestamp) : DateUtils.nowForInput();
    timeInput.addEventListener("change", () => {
      cand.timestamp = timeInput.value ? new Date(timeInput.value).toISOString() : null;
    });
    timeField.append(timeLabel, timeInput);
    wrap.appendChild(timeField);

    const noteField = document.createElement("div");
    noteField.className = "field";
    const noteLabel = document.createElement("label");
    noteLabel.textContent = "Note";
    const noteInput = document.createElement("textarea");
    noteInput.rows = 3;
    noteInput.value = cand.note;
    noteInput.addEventListener("input", () => {
      cand.note = noteInput.value;
    });
    noteField.append(noteLabel, noteInput);
    wrap.appendChild(noteField);

    return wrap;
  }

  function buildCandidateCard(cand) {
    const card = document.createElement("div");
    card.className = "import-candidate";

    const header = document.createElement("label");
    header.className = "import-candidate-header";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = cand.include;
    checkbox.addEventListener("change", () => {
      cand.include = checkbox.checked;
      renderCandidateList();
    });
    header.appendChild(checkbox);

    const summary = document.createElement("span");
    summary.className = "import-candidate-summary";
    summary.textContent = cand.timestamp
      ? new Date(cand.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "No date detected";
    header.appendChild(summary);

    if (cand.severity) {
      const sev = document.createElement("span");
      sev.className = "severity-badge";
      sev.dataset.severity = String(cand.severity);
      sev.textContent = `Sev ${cand.severity}`;
      header.appendChild(sev);
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "import-candidate-edit-btn";
    editBtn.textContent = cand.expanded ? "Done" : "Edit";
    editBtn.addEventListener("click", (e) => {
      e.preventDefault(); // the header is a <label>; don't let this also toggle the checkbox
      cand.expanded = !cand.expanded;
      renderCandidateList();
    });
    header.appendChild(editBtn);

    card.appendChild(header);

    if (cand.expanded) {
      card.appendChild(buildCandidateEditor(cand));
      return card;
    }

    if (cand.tags.size > 0 || cand.conditions.size > 0) {
      const tagRow = document.createElement("div");
      tagRow.className = "timeline-item-tags";
      cand.tags.forEach((name) => {
        const chip = document.createElement("span");
        chip.className = "chip chip-static";
        chip.textContent = name;
        tagRow.appendChild(chip);
      });
      cand.conditions.forEach((name) => {
        const condChip = document.createElement("span");
        condChip.className = "chip chip-static chip-condition";
        condChip.textContent = name;
        tagRow.appendChild(condChip);
      });
      card.appendChild(tagRow);
    }

    if (cand.note) {
      const note = document.createElement("div");
      note.className = "timeline-item-note";
      note.textContent = cand.note;
      card.appendChild(note);
    }

    return card;
  }

  function renderCandidateList() {
    const wrap = container.querySelector("#import-candidates");
    wrap.innerHTML = "";
    candidates.forEach((cand) => wrap.appendChild(buildCandidateCard(cand)));

    const confirmBtn = container.querySelector("#import-candidates-confirm-btn");
    const selectedCount = candidates.filter((c) => c.include).length;
    confirmBtn.hidden = candidates.length === 0;
    confirmBtn.disabled = selectedCount === 0;
    confirmBtn.textContent = `Import ${selectedCount} Selected`;
  }

  async function confirmCandidateImport() {
    const toImport = candidates.filter((c) => c.include);
    if (toImport.length === 0) return;

    const btn = container.querySelector("#import-candidates-confirm-btn");
    const statusEl = container.querySelector("#import-text-status");
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Importing…";

    try {
      for (const c of toImport) {
        const timestamp = c.timestamp || new Date().toISOString();
        for (const name of c.tags) {
          await DB.touchTag(name, timestamp);
        }
        for (const name of c.conditions) {
          await DB.touchCondition(name, timestamp);
        }
        await DB.addEntry({
          timestamp,
          tags: Array.from(c.tags),
          conditions: Array.from(c.conditions),
          severity: c.severity,
          note: c.note,
        });
      }

      candidates = candidates.filter((c) => !c.include); // keep anything the user left unchecked
      statusEl.textContent = `Imported ${toImport.length} ${toImport.length === 1 ? "entry" : "entries"}.`;
      container.querySelector("#import-text-file").value = "";
      renderCandidateList();
      await loadExportSummary();
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Import failed partway through — check the Timeline for what made it in.";
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ---- Manage Tags ----

  async function loadTagUsage() {
    const entries = await DB.getAllEntries();
    const counts = {};
    entries.forEach((e) => (e.tags || []).forEach((name) => {
      counts[name] = (counts[name] || 0) + 1;
    }));
    tagUsageCounts = counts;
  }

  function renderTagManageList() {
    const wrap = container.querySelector("#tag-manage-list");
    wrap.innerHTML = "";

    if (allTags.length === 0) {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "No tags yet.";
      wrap.appendChild(p);
      return;
    }

    allTags
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((tag) => wrap.appendChild(buildTagManageRow(tag)));
  }

  function buildTagManageRow(tag) {
    const row = document.createElement("div");
    row.className = "tag-manage-row";

    const info = document.createElement("div");
    info.className = "tag-manage-info";

    const nameEl = document.createElement("span");
    nameEl.className = "tag-manage-name";
    nameEl.textContent = tag.name;
    info.appendChild(nameEl);

    const count = tagUsageCounts[tag.name] || 0;
    const meta = document.createElement("span");
    meta.className = "tag-manage-meta";
    meta.textContent = `${count} ${count === 1 ? "entry" : "entries"}`;
    info.appendChild(meta);

    row.appendChild(info);

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "tag-manage-rename-btn";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => startTagRename(row, tag));
    row.appendChild(renameBtn);

    return row;
  }

  /** Swaps a tag row into an inline rename form; Enter/Save commits, Escape/Cancel reverts. */
  function startTagRename(row, tag) {
    row.innerHTML = "";
    row.classList.add("tag-manage-row-editing");

    const inputRow = document.createElement("div");
    inputRow.className = "tag-manage-edit-input-row";

    const input = document.createElement("input");
    input.type = "text";
    input.value = tag.name;

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    saveBtn.className = "tag-manage-rename-save";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";

    inputRow.append(input, saveBtn, cancelBtn);

    const errorEl = document.createElement("p");
    errorEl.className = "import-status";

    row.append(inputRow, errorEl);
    input.focus();
    input.select();

    cancelBtn.addEventListener("click", () => renderTagManageList());

    async function commitRename() {
      const newName = input.value.trim();
      if (!newName || newName === tag.name) {
        renderTagManageList();
        return;
      }
      saveBtn.disabled = true;
      try {
        await DB.renameTag(tag.name, newName);
        await loadPickerData();
        await loadTagUsage();
        renderTagManageList();
      } catch (err) {
        errorEl.textContent = err.message || "Couldn't rename that tag.";
        saveBtn.disabled = false;
      }
    }

    saveBtn.addEventListener("click", commitRename);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        renderTagManageList();
      }
    });
  }

  // ---- Render + wiring ----

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

      <hr class="section-divider" />
      <h2 class="section-heading">Manage Tags</h2>
      <p class="export-note" style="margin-top: 0">
        Rename a tag if the wording no longer fits — every entry using it updates automatically.
      </p>
      <div id="tag-manage-list" class="tag-manage-list"></div>

      <hr class="section-divider" />
      <h2 class="section-heading">Restore a backup</h2>
      <div class="field">
        <label for="import-structured-file">JSON backup or CSV</label>
        <input type="file" id="import-structured-file" accept=".json,.csv,application/json,text/csv" />
        <p id="import-structured-status" class="import-status"></p>
        <div id="import-structured-preview" class="import-preview" hidden>
          <p id="import-structured-summary"></p>
          <button type="button" id="import-structured-confirm-btn" class="primary-btn">Import</button>
        </div>
      </div>

      <hr class="section-divider" />
      <h2 class="section-heading">Extract from a text file</h2>
      <p class="export-note" style="margin-top: 0">
        Scans a plain-text journal for date lines, then matches your existing tags/conditions and
        simple severity words ("mild", "severe", "4/5"). Runs entirely on this device — nothing is
        sent anywhere. Always review the guesses before importing; it can only recognize tags and
        conditions you've already created.
      </p>
      <div class="field">
        <label for="import-text-file">Plain-text journal (.txt)</label>
        <input type="file" id="import-text-file" accept=".txt,text/plain" />
        <p id="import-text-status" class="import-status"></p>
      </div>
      <div id="import-candidates" class="import-candidates"></div>
      <button type="button" id="import-candidates-confirm-btn" class="primary-btn" hidden>Import Selected</button>
    `;
  }

  async function init() {
    container = document.getElementById("view-data");
    render();

    container.querySelector("#export-json-btn").addEventListener("click", (e) => {
      withStatus(e.currentTarget, "Preparing…", exportJson);
    });
    container.querySelector("#export-csv-btn").addEventListener("click", (e) => {
      withStatus(e.currentTarget, "Preparing…", exportCsv);
    });

    container.querySelector("#import-structured-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleStructuredFile(file);
    });
    container.querySelector("#import-structured-confirm-btn").addEventListener("click", confirmStructuredImport);

    container.querySelector("#import-text-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleTextFile(file);
    });
    container.querySelector("#import-candidates-confirm-btn").addEventListener("click", confirmCandidateImport);

    await loadExportSummary();
    await loadPickerData();
    await loadTagUsage();
    renderTagManageList();
  }

  async function onShow() {
    await loadExportSummary();
    await loadPickerData();
    await loadTagUsage();
    renderTagManageList();
  }

  return { init, onShow };
})();

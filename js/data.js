/**
 * Data view: Export (JSON/CSV via the iOS share sheet) plus Import, in five
 * flavors:
 *  - Restore a JSON backup (this app's own export format, full fidelity -
 *    entries, tags, conditions, factors/factorEntries, and temperatures).
 *  - Bulk-import a CSV (this app's own export columns, or a hand-made one
 *    with at least a "timestamp" column).
 *  - Extract entries from a plain-text journal via a local heuristic
 *    (js/importer.js) - never sent anywhere, and always shown as a
 *    review-before-import list since the guesses won't always be right.
 *  - Import daily temperature readings (`YYYY-MM-DD    value` per line),
 *    stored as-is for Trends' Temperature chart, and optionally
 *    auto-flagged as "Heatwave" factor entries above a threshold you set.
 *  - Import a factor log (`YYYY-MM-DD <name>`, or a `YYYY-MM-DD to
 *    YYYY-MM-DD <name>` range expanded into daily entries) - the bulk
 *    alternative to logging each day one at a time in the Log tab.
 */
const DataView = (() => {
  let container;
  let allTags = [];
  let allConditions = [];
  let allFactors = []; // for the Manage Factors list (chart display type)
  let pendingStructuredImport = null; // { entries, tags, conditions, factorEntries, factors, temperatures, triggers } awaiting confirmation
  let structuredImportMode = "append"; // "append" | "replace" - reset to "append" on every new file pick
  let candidates = []; // text-extraction candidates awaiting review
  let tagUsageCounts = {}; // tag name -> entry count, for the Manage Tags list
  let tagManageSortMode = "name"; // "name" | "frequency" - view-only, not persisted to Settings
  let conditionUsageCounts = {}; // condition name -> entry count, for the Manage Conditions list
  let armedConditionDeleteName = null; // two-tap delete: first tap arms this condition's row, a second tap deletes
  let pendingTemperatureImport = null; // { readings, skippedCount } awaiting confirmation
  let pendingFactorLogImport = null; // { entries, skippedCount } awaiting confirmation
  let factorLogImportMode = "append"; // "append" | "replace" - reset to "append" on every new file pick

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
    const [entries, tags, conditions, factorEntries, factors, temperatures, triggers] = await Promise.all([
      DB.getAllEntries(),
      DB.getAllTags(),
      DB.getAllConditions(),
      DB.getAllFactorEntries(),
      DB.getAllFactors(),
      DB.getAllTemperatures(),
      DB.getAllTriggers(),
    ]);
    const payload = { exportedAt: new Date().toISOString(), entries, tags, conditions, factorEntries, factors, temperatures, triggers };
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

  function syncStructuredImportModeChips() {
    // Scoped to #import-structured-preview specifically - the factor log
    // import section below has its own, separately-scoped mode row.
    container.querySelectorAll("#import-structured-preview .import-mode-row .chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", chip.dataset.importMode === structuredImportMode ? "true" : "false");
    });
  }

  /** Rebuilds the summary text under the mode chips - depends on both the parsed file and the append/replace choice. */
  async function renderStructuredImportSummary() {
    if (!pendingStructuredImport) return;
    const { entries, tags, conditions, factorEntries, factors, temperatures, triggers } = pendingStructuredImport;

    const parts = [`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`];
    if (tags.length) parts.push(`${tags.length} ${tags.length === 1 ? "tag" : "tags"}`);
    if (conditions.length) parts.push(`${conditions.length} ${conditions.length === 1 ? "condition" : "conditions"}`);
    if (factorEntries.length) {
      const factorNameCount = new Set(factorEntries.map((fe) => fe.name)).size;
      parts.push(`${factorEntries.length} factor entries across ${factorNameCount} ${factorNameCount === 1 ? "factor" : "factors"}`);
    }
    if (temperatures.length) parts.push(`${temperatures.length} temperature readings`);
    if (triggers.length) parts.push(`${triggers.length} ${triggers.length === 1 ? "trigger" : "triggers"}`);
    let found = `Found ${parts.join(", ")}.`;
    if (tags.length === 0 && conditions.length === 0) {
      found += " No tags/conditions section in this file - tags and their tracking-started dates will be recomputed from the entries themselves.";
    }
    if (factorEntries.length > 0 && factors.length === 0) {
      found += " No factors section in this file - factor tracking-started dates will be recomputed from the factor entries themselves.";
    }

    let action;
    if (structuredImportMode === "replace") {
      const [currentCount, currentFactorEntryCount] = await Promise.all([
        DB.getAllEntries().then((e) => e.length),
        DB.getAllFactorEntries().then((e) => e.length),
      ]);
      if (currentCount > 0 || currentFactorEntryCount > 0) {
        const deletedParts = [`${currentCount} existing ${currentCount === 1 ? "entry" : "entries"}`];
        if (currentFactorEntryCount > 0) {
          deletedParts.push(`${currentFactorEntryCount} factor ${currentFactorEntryCount === 1 ? "entry" : "entries"}`);
        }
        action = `This will permanently delete all ${deletedParts.join(" and ")} - AND every existing tag, condition, factor, trigger, and temperature reading, even ones not in this file - replacing everything with just what's in this file.`;
      } else {
        action = `This will import the ${entries.length} entries from this file (nothing existing to replace yet).`;
      }
    } else {
      action =
        "This adds to what's already stored - entries/factor entries sharing an id with one you already have are updated in place, not duplicated. Records you deleted from the file are NOT removed; use Replace All for that.";
    }

    container.querySelector("#import-structured-summary").textContent = `${found} ${action}`;
  }

  async function handleStructuredFile(file) {
    const statusEl = container.querySelector("#import-structured-status");
    const previewEl = container.querySelector("#import-structured-preview");
    previewEl.hidden = true;
    pendingStructuredImport = null;
    structuredImportMode = "append";
    syncStructuredImportModeChips();
    statusEl.textContent = "Reading file…";

    try {
      const text = await file.text();
      let entries, tags, conditions, factorEntries, factors, temperatures, triggers;
      if (file.name.toLowerCase().endsWith(".json")) {
        ({ entries, tags, conditions, factorEntries, factors, temperatures, triggers } = Importer.parseJsonBackup(text));
      } else {
        entries = Importer.csvToEntries(text);
        tags = [];
        conditions = [];
        factorEntries = [];
        factors = [];
        temperatures = [];
        triggers = [];
      }

      pendingStructuredImport = { entries, tags, conditions, factorEntries, factors, temperatures, triggers };
      statusEl.textContent = "";
      await renderStructuredImportSummary();
      previewEl.hidden = false;
    } catch (err) {
      console.error(err);
      statusEl.textContent = err.message || "Couldn't read that file.";
    }
  }

  /**
   * The earliest timestamp, per name, among entries referencing it under
   * `field` ("tags" or "conditions"). Used to (re)compute an accurate
   * firstUsed/createdAt in one pass instead of one DB round-trip per
   * (entry, name) pair - the touchTag/touchCondition backward-only
   * correction would converge to the same result either way, but this is
   * both faster and makes the "recompute from entries" intent explicit,
   * so a tags/conditions section becomes wholly optional in the file.
   */
  function computeEarliestByName(entries, field) {
    const earliest = new Map();
    entries.forEach((e) => {
      (e[field] || []).forEach((name) => {
        const current = earliest.get(name);
        if (!current || new Date(e.timestamp) < new Date(current)) {
          earliest.set(name, e.timestamp);
        }
      });
    });
    return earliest;
  }

  /** Same idea as computeEarliestByName, but factor entries have a singular `name` string, not an array field. */
  function computeEarliestByFactorName(factorEntries) {
    const earliest = new Map();
    factorEntries.forEach((fe) => {
      const current = earliest.get(fe.name);
      if (!current || new Date(fe.timestamp) < new Date(current)) {
        earliest.set(fe.name, fe.timestamp);
      }
    });
    return earliest;
  }

  /**
   * Runs the actual import - no confirm() dialog gate: those are silently
   * broken in an installed iOS PWA (standalone display mode doesn't show
   * native confirm/alert/prompt at all, so `if (!confirm(...)) return`
   * would just exit immediately with no visible effect, which is exactly
   * what "Replace All does nothing" was). The destructive consequences of
   * Replace All are stated up front in the summary text instead, and the
   * whole import runs as one batched DB.bulkImportEntries() transaction
   * rather than a separate transaction per tag/condition/entry, so it
   * can't feel like it's hung on a real export either.
   */
  async function confirmStructuredImport() {
    if (!pendingStructuredImport) return;
    const btn = container.querySelector("#import-structured-confirm-btn");
    const statusEl = container.querySelector("#import-structured-status");
    const { entries, tags, conditions, factorEntries, factors, temperatures, triggers } = pendingStructuredImport;
    const isReplace = structuredImportMode === "replace";

    btn.disabled = true;
    btn.textContent = "Importing…";

    try {
      const entriesWithIds = entries.map((e) => ({ ...e, id: e.id || DB.uuid() }));
      const factorEntriesWithIds = factorEntries.map((fe) => ({ ...fe, id: fe.id || DB.uuid() }));
      await DB.bulkImportEntries({
        entries: entriesWithIds,
        tagRecords: tags,
        conditionRecords: conditions,
        tagFirstUse: computeEarliestByName(entries, "tags"),
        conditionFirstUse: computeEarliestByName(entries, "conditions"),
        clearExistingEntries: isReplace,
        factorEntryRecords: factorEntriesWithIds,
        factorRecords: factors,
        factorFirstUse: computeEarliestByFactorName(factorEntries),
        temperatureRecords: temperatures,
        triggerRecords: triggers,
        triggerFirstUse: computeEarliestByName(entries, "triggerTags"),
      });

      let statusText = `${isReplace ? "Replaced all entries with" : "Imported"} ${entries.length} ${
        entries.length === 1 ? "entry" : "entries"
      }.`;
      if (factorEntries.length > 0) {
        statusText += ` ${factorEntries.length} factor ${factorEntries.length === 1 ? "entry" : "entries"} and ${temperatures.length} temperature ${
          temperatures.length === 1 ? "reading" : "readings"
        } also restored.`;
      } else if (temperatures.length > 0) {
        statusText += ` ${temperatures.length} temperature ${temperatures.length === 1 ? "reading" : "readings"} also restored.`;
      }
      statusEl.textContent = statusText;
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
    [allTags, allConditions, allFactors] = await Promise.all([DB.getAllTags(), DB.getAllConditions(), DB.getAllFactors()]);
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

  // ---- Import: temperature log ----

  function formatTemperature(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  /** Rebuilds the parsed-file summary line - depends only on the parsed readings, not the threshold. */
  function renderTemperatureSummary() {
    if (!pendingTemperatureImport) return;
    const { readings, skippedCount } = pendingTemperatureImport;
    const values = readings.map((r) => r.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((s, v) => s + v, 0) / values.length;

    let summary = `${readings.length} ${readings.length === 1 ? "reading" : "readings"} found`;
    if (skippedCount > 0) summary += ` (${skippedCount} ${skippedCount === 1 ? "line" : "lines"} skipped)`;
    summary += `. Range: ${formatTemperature(min)}° to ${formatTemperature(max)}°, avg ${formatTemperature(avg)}°.`;
    container.querySelector("#import-temperature-summary").textContent = summary;
  }

  /** Rebuilds the "K of N days would be flagged" preview - depends on both the parsed file and the threshold input. */
  function renderHeatwaveThresholdPreview() {
    if (!pendingTemperatureImport) return;
    const previewEl = container.querySelector("#heatwave-threshold-preview");
    const raw = container.querySelector("#heatwave-threshold-input").value;
    if (raw === "") {
      previewEl.textContent = "No threshold set - only raw values will be stored.";
      return;
    }
    const threshold = Number(raw);
    if (isNaN(threshold)) {
      previewEl.textContent = "";
      return;
    }
    const flaggedCount = pendingTemperatureImport.readings.filter((r) => r.value >= threshold).length;
    previewEl.textContent = `${flaggedCount} of ${pendingTemperatureImport.readings.length} days would be flagged as Heatwave.`;
  }

  async function handleTemperatureFile(file) {
    const statusEl = container.querySelector("#import-temperature-status");
    const previewEl = container.querySelector("#import-temperature-preview");
    previewEl.hidden = true;
    pendingTemperatureImport = null;
    container.querySelector("#heatwave-threshold-input").value = "";
    statusEl.textContent = "Reading file…";

    try {
      const text = await file.text();
      const { readings, skippedCount } = Importer.parseTemperatureFile(text);
      if (readings.length === 0) {
        // Surface what was actually read (not just "it didn't work") - the
        // most common cause is the file's real delimiter/format not matching
        // what was expected, which this makes visible without needing devtools.
        const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "(file appears to be empty)";
        statusEl.textContent = `Couldn't find any valid readings in that file (${text.length} characters read). First line: "${firstLine.slice(0, 80)}"`;
        return;
      }

      pendingTemperatureImport = { readings, skippedCount };
      statusEl.textContent = "";
      renderTemperatureSummary();
      renderHeatwaveThresholdPreview();
      previewEl.hidden = false;
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Couldn't read that file.";
    }
  }

  /**
   * Runs the actual import - same no-confirm()-dialog reasoning as
   * confirmStructuredImport: the effect of the threshold is already shown
   * live in the preview text above, so there's nothing left to confirm.
   */
  async function confirmTemperatureImport() {
    if (!pendingTemperatureImport) return;
    const btn = container.querySelector("#import-temperature-confirm-btn");
    const statusEl = container.querySelector("#import-temperature-status");
    const { readings } = pendingTemperatureImport;
    const thresholdRaw = container.querySelector("#heatwave-threshold-input").value;
    const threshold = thresholdRaw === "" ? null : Number(thresholdRaw);

    btn.disabled = true;
    btn.textContent = "Importing…";

    try {
      let heatwaveDates = [];
      if (threshold != null && !isNaN(threshold)) {
        const existingHeatwaveDays = new Set(
          (await DB.getAllFactorEntries()).filter((e) => e.name === "Heatwave").map((e) => Analysis.dayKey(e.timestamp))
        );
        heatwaveDates = readings
          .filter((r) => r.value >= threshold && !existingHeatwaveDays.has(r.date))
          .map((r) => new Date(`${r.date}T12:00:00`).toISOString())
          .sort();
      }

      await DB.bulkImportTemperatures({ temperatures: readings.map((r) => ({ date: r.date, value: r.value })), heatwaveDates });

      statusEl.textContent =
        heatwaveDates.length > 0
          ? `Imported ${readings.length} readings. Flagged ${heatwaveDates.length} new Heatwave ${heatwaveDates.length === 1 ? "day" : "days"}.`
          : `Imported ${readings.length} readings.`;
      container.querySelector("#import-temperature-preview").hidden = true;
      container.querySelector("#import-temperature-file").value = "";
      pendingTemperatureImport = null;
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Import failed partway through.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Import";
    }
  }

  // ---- Import: factor log ----

  function syncFactorLogImportModeChips() {
    container.querySelectorAll(".factorlog-import-mode-row .chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", chip.dataset.importMode === factorLogImportMode ? "true" : "false");
    });
  }

  /** Rebuilds the parsed-file summary line for the factor log preview - depends on both the parsed file and the append/replace choice. */
  async function renderFactorLogSummary() {
    if (!pendingFactorLogImport) return;
    const { entries, skippedCount } = pendingFactorLogImport;
    const factorCount = new Set(entries.map((e) => e.name)).size;

    let found = `Found ${entries.length} ${entries.length === 1 ? "entry" : "entries"} across ${factorCount} ${factorCount === 1 ? "factor" : "factors"}`;
    if (skippedCount > 0) found += ` (${skippedCount} ${skippedCount === 1 ? "line" : "lines"} skipped)`;
    found += ".";

    let action;
    if (factorLogImportMode === "replace") {
      const currentCount = (await DB.getAllFactorEntries()).length;
      action =
        currentCount > 0
          ? `This will permanently delete all ${currentCount} existing factor ${currentCount === 1 ? "entry" : "entries"} and replace them with the file's data.`
          : `This will import the file's factor entries (nothing existing to replace yet).`;
    } else {
      action = "This adds to what's already logged - matching day+factor pairs already logged are skipped, not duplicated.";
    }

    container.querySelector("#import-factorlog-summary").textContent = `${found} ${action}`;
  }

  async function handleFactorLogFile(file) {
    const statusEl = container.querySelector("#import-factorlog-status");
    const previewEl = container.querySelector("#import-factorlog-preview");
    previewEl.hidden = true;
    pendingFactorLogImport = null;
    factorLogImportMode = "append";
    syncFactorLogImportModeChips();
    statusEl.textContent = "Reading file…";

    try {
      const text = await file.text();
      const { entries, skippedCount } = Importer.parseFactorLogFile(text);
      if (entries.length === 0) {
        // Same "show what was actually read" diagnostic as the temperature
        // import - makes a format/delimiter mismatch visible without devtools.
        const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "(file appears to be empty)";
        statusEl.textContent = `Couldn't find any valid entries in that file (${text.length} characters read). First line: "${firstLine.slice(0, 80)}"`;
        return;
      }

      pendingFactorLogImport = { entries, skippedCount };
      statusEl.textContent = "";
      await renderFactorLogSummary();
      previewEl.hidden = false;
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Couldn't read that file.";
    }
  }

  /** Runs the actual import - no confirm() dialog, same reasoning as the other imports (destructive consequences are stated up front in the summary text instead). */
  async function confirmFactorLogImport() {
    if (!pendingFactorLogImport) return;
    const btn = container.querySelector("#import-factorlog-confirm-btn");
    const statusEl = container.querySelector("#import-factorlog-status");
    const { entries } = pendingFactorLogImport;
    const isReplace = factorLogImportMode === "replace";

    btn.disabled = true;
    btn.textContent = "Importing…";

    try {
      let newEntries;
      if (isReplace) {
        // Replace All: every parsed entry is imported as-is, no dedup needed
        // since the existing factorEntries store is about to be cleared anyway.
        newEntries = entries.map((e) => ({ name: e.name, timestamp: new Date(`${e.date}T12:00:00`).toISOString() }));
      } else {
        const existingDayNamePairs = new Set(
          (await DB.getAllFactorEntries()).map((e) => `${Analysis.dayKey(e.timestamp)}|${e.name}`)
        );
        newEntries = entries
          .filter((e) => !existingDayNamePairs.has(`${e.date}|${e.name}`))
          .map((e) => ({ name: e.name, timestamp: new Date(`${e.date}T12:00:00`).toISOString() }));
      }

      await DB.bulkImportFactorEntries(newEntries, { clearExisting: isReplace });

      const factorCount = new Set(newEntries.map((e) => e.name)).size;
      if (isReplace) {
        statusEl.textContent = `Replaced all factor entries with ${newEntries.length} across ${factorCount} ${factorCount === 1 ? "factor" : "factors"}.`;
      } else {
        const skippedAsDuplicate = entries.length - newEntries.length;
        statusEl.textContent =
          skippedAsDuplicate > 0
            ? `Imported ${newEntries.length} new factor entries across ${factorCount} ${factorCount === 1 ? "factor" : "factors"} (${skippedAsDuplicate} already logged, skipped).`
            : `Imported ${newEntries.length} new factor entries across ${factorCount} ${factorCount === 1 ? "factor" : "factors"}.`;
      }
      container.querySelector("#import-factorlog-preview").hidden = true;
      container.querySelector("#import-factorlog-file").value = "";
      pendingFactorLogImport = null;
    } catch (err) {
      console.error(err);
      statusEl.textContent = "Import failed partway through.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Import";
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

    const sorted = allTags.slice().sort((a, b) => {
      if (tagManageSortMode === "frequency") {
        return (tagUsageCounts[a.name] || 0) - (tagUsageCounts[b.name] || 0);
      }
      return a.name.localeCompare(b.name);
    });
    sorted.forEach((tag) => wrap.appendChild(buildTagManageRow(tag)));
  }

  /** Keeps the Manage Tags sort chips in sync with tagManageSortMode. */
  function syncTagManageSortChips() {
    container.querySelectorAll("#tag-manage-sort-row .chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", chip.dataset.sort === tagManageSortMode ? "true" : "false");
    });
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

    const actions = document.createElement("div");
    actions.className = "tag-manage-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "tag-manage-rename-btn";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => startTagRename(row, tag));
    actions.appendChild(renameBtn);

    const mergeBtn = document.createElement("button");
    mergeBtn.type = "button";
    mergeBtn.className = "tag-manage-rename-btn";
    mergeBtn.textContent = "Merge";
    mergeBtn.addEventListener("click", () => startTagMerge(row, tag));
    actions.appendChild(mergeBtn);

    row.appendChild(actions);

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

  /**
   * Swaps a tag row into an inline merge form: a <select> of every other
   * tag (labeled with its own entry count) plus a two-tap Merge/Confirm
   * button - merge is more destructive than rename or delete (it rewrites
   * both tags and notes on every affected entry), so it gets both an
   * explicit non-defaulted target choice and a second confirming tap.
   */
  function startTagMerge(row, tag) {
    row.innerHTML = "";
    row.classList.add("tag-manage-row-editing");

    const others = allTags.filter((t) => t.name !== tag.name).sort((a, b) => a.name.localeCompare(b.name));

    const inputRow = document.createElement("div");
    inputRow.className = "tag-manage-edit-input-row";

    const select = document.createElement("select");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Merge into...";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    others.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.name;
      const count = tagUsageCounts[t.name] || 0;
      opt.textContent = `${t.name} (${count} ${count === 1 ? "entry" : "entries"})`;
      select.appendChild(opt);
    });

    const mergeBtn = document.createElement("button");
    mergeBtn.type = "button";
    mergeBtn.textContent = "Merge";
    mergeBtn.className = "tag-manage-rename-save";
    mergeBtn.disabled = others.length === 0;

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";

    inputRow.append(select, mergeBtn, cancelBtn);

    const errorEl = document.createElement("p");
    errorEl.className = "import-status";

    row.append(inputRow, errorEl);

    cancelBtn.addEventListener("click", () => renderTagManageList());

    let armed = false;

    select.addEventListener("change", () => {
      armed = false;
      mergeBtn.textContent = "Merge";
    });

    mergeBtn.addEventListener("click", async () => {
      const targetName = select.value;
      if (!targetName) {
        errorEl.textContent = "Pick a tag to merge into.";
        return;
      }
      if (!armed) {
        armed = true;
        mergeBtn.textContent = "Confirm merge?";
        errorEl.textContent = "";
        return;
      }
      mergeBtn.disabled = true;
      try {
        await DB.mergeTag(tag.name, targetName);
        await loadPickerData();
        await loadTagUsage();
        renderTagManageList();
      } catch (err) {
        errorEl.textContent = err.message || "Couldn't merge that tag.";
        mergeBtn.disabled = false;
        armed = false;
        mergeBtn.textContent = "Merge";
      }
    });
  }

  // ---- Manage Conditions ----

  async function loadConditionUsage() {
    const entries = await DB.getAllEntries();
    const counts = {};
    entries.forEach((e) => (e.conditions || []).forEach((name) => {
      counts[name] = (counts[name] || 0) + 1;
    }));
    conditionUsageCounts = counts;
  }

  function renderConditionManageList() {
    const wrap = container.querySelector("#condition-manage-list");
    wrap.innerHTML = "";

    if (allConditions.length === 0) {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "No conditions yet.";
      wrap.appendChild(p);
      return;
    }

    allConditions
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((condition) => wrap.appendChild(buildConditionManageRow(condition)));
  }

  function buildConditionManageRow(condition) {
    const row = document.createElement("div");
    row.className = "tag-manage-row";

    const info = document.createElement("div");
    info.className = "tag-manage-info";

    const nameEl = document.createElement("span");
    nameEl.className = "tag-manage-name";
    nameEl.textContent = condition.name;
    info.appendChild(nameEl);

    const count = conditionUsageCounts[condition.name] || 0;
    const meta = document.createElement("span");
    meta.className = "tag-manage-meta";
    meta.textContent = `${count} ${count === 1 ? "entry" : "entries"}`;
    info.appendChild(meta);

    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "tag-manage-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "tag-manage-rename-btn";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => startConditionRename(row, condition));
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "tag-manage-rename-btn modal-delete";
    deleteBtn.textContent = armedConditionDeleteName === condition.name ? "Confirm?" : "Delete";
    deleteBtn.addEventListener("click", () => handleDeleteCondition(condition.name));
    actions.appendChild(deleteBtn);

    row.appendChild(actions);

    return row;
  }

  /** Swaps a condition row into an inline rename form; Enter/Save commits, Escape/Cancel reverts. Verbatim mirror of startTagRename. */
  function startConditionRename(row, condition) {
    row.innerHTML = "";
    row.classList.add("tag-manage-row-editing");

    const inputRow = document.createElement("div");
    inputRow.className = "tag-manage-edit-input-row";

    const input = document.createElement("input");
    input.type = "text";
    input.value = condition.name;

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

    cancelBtn.addEventListener("click", () => renderConditionManageList());

    async function commitRename() {
      const newName = input.value.trim();
      if (!newName || newName === condition.name) {
        renderConditionManageList();
        return;
      }
      saveBtn.disabled = true;
      try {
        await DB.renameCondition(condition.name, newName);
        await loadPickerData();
        await loadConditionUsage();
        renderConditionManageList();
      } catch (err) {
        errorEl.textContent = err.message || "Couldn't rename that condition.";
        saveBtn.disabled = false;
      }
    }

    saveBtn.addEventListener("click", commitRename);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        renderConditionManageList();
      }
    });
  }

  /**
   * Two-tap in-page confirmation, same reasoning as Log's factor-entry
   * delete: window.confirm() silently no-ops in an installed iOS home-screen
   * PWA. Only one row can be "armed" at a time - arming a different row's
   * delete disarms whichever was previously armed.
   */
  async function handleDeleteCondition(name) {
    if (armedConditionDeleteName !== name) {
      armedConditionDeleteName = name;
      renderConditionManageList();
      return;
    }

    await DB.deleteCondition(name);
    armedConditionDeleteName = null;
    await loadPickerData();
    await loadConditionUsage();
    renderConditionManageList();
  }

  // ---- Manage Factors ----

  const FACTOR_DISPLAY_TYPES = [
    { value: "bar", label: "Bar" },
    { value: "line", label: "Line" },
    { value: "span", label: "Area" },
  ];

  function renderFactorManageList() {
    const wrap = container.querySelector("#factor-manage-list");
    wrap.innerHTML = "";

    if (allFactors.length === 0) {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "No factors yet.";
      wrap.appendChild(p);
      return;
    }

    allFactors
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((factor) => wrap.appendChild(buildFactorManageRow(factor)));
  }

  /** How a factor renders on Trends' charts: a bar count per bucket (default), a vertical line per occurrence, or a shaded date-range span. */
  function buildFactorManageRow(factor) {
    const row = document.createElement("div");
    row.className = "tag-manage-row";

    const info = document.createElement("div");
    info.className = "tag-manage-info";

    const nameEl = document.createElement("span");
    nameEl.className = "tag-manage-name";
    nameEl.textContent = factor.name;
    info.appendChild(nameEl);

    row.appendChild(info);

    const typeRow = document.createElement("div");
    typeRow.className = "chip-row factor-display-type-row";
    const currentType = factor.displayType || "bar";
    FACTOR_DISPLAY_TYPES.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = opt.label;
      btn.setAttribute("aria-pressed", currentType === opt.value ? "true" : "false");
      btn.addEventListener("click", async () => {
        const updated = await DB.setFactorDisplayType(factor.name, opt.value);
        if (updated) {
          const idx = allFactors.findIndex((f) => f.name === factor.name);
          if (idx !== -1) allFactors[idx] = updated;
        }
        renderFactorManageList();
      });
      typeRow.appendChild(btn);
    });
    row.appendChild(typeRow);

    return row;
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
        JSON keeps full fidelity (entries, tags, conditions, factors, triggers, temperature data) for backup.
        CSV is for opening in a spreadsheet (symptom entries only). Nothing leaves this device
        except through this deliberate export action.
      </p>

      <hr class="section-divider" />
      <h2 class="section-heading">Manage Tags</h2>
      <p class="export-note" style="margin-top: 0">
        Rename a tag if the wording no longer fits — every entry using it updates automatically. Merge
        a low-frequency tag into another to declutter — the old name is kept in the entry's note as a
        descriptor.
      </p>
      <div class="chip-row" id="tag-manage-sort-row">
        <button type="button" class="chip" data-sort="name" aria-pressed="true">Sort: Name</button>
        <button type="button" class="chip" data-sort="frequency" aria-pressed="false">Sort: Frequency</button>
      </div>
      <div id="tag-manage-list" class="tag-manage-list"></div>

      <hr class="section-divider" />
      <h2 class="section-heading">Manage Conditions</h2>
      <p class="export-note" style="margin-top: 0">
        Rename or delete a condition - every entry using it updates (or drops it) automatically.
      </p>
      <div id="condition-manage-list" class="tag-manage-list"></div>

      <hr class="section-divider" />
      <h2 class="section-heading">Manage Factors</h2>
      <p class="export-note" style="margin-top: 0">
        How each factor renders on Trends' charts: Bar (a count per bucket, the default), Line (a
        vertical marker at each occurrence - good for one-off things like a medication change), or
        Area (a shaded date range across a recurring run of days - good for something like a period).
      </p>
      <div id="factor-manage-list" class="tag-manage-list"></div>

      <hr class="section-divider" />
      <h2 class="section-heading">Restore a backup</h2>
      <p class="export-note" style="margin-top: 0">
        Round-trips with Export above: export JSON, edit it (fix a note, remove an entry, tweak a
        tag), then import it back here.
      </p>
      <div class="field">
        <label for="import-structured-file">JSON backup or CSV</label>
        <input type="file" id="import-structured-file" accept=".json,.csv,application/json,text/csv" />
        <p id="import-structured-status" class="import-status"></p>
        <div id="import-structured-preview" class="import-preview" hidden>
          <div class="import-mode-row chip-row">
            <button type="button" class="chip" data-import-mode="append" aria-pressed="true">Append</button>
            <button type="button" class="chip" data-import-mode="replace" aria-pressed="false">Replace All</button>
          </div>
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

      <hr class="section-divider" />
      <h2 class="section-heading">Import Temperature Data</h2>
      <p class="export-note" style="margin-top: 0">
        One reading per line: a date, then the value (e.g. "2026-01-01    6.0"). Values are stored
        as-is for comparison against symptom charts in Trends.
      </p>
      <div class="field">
        <label for="import-temperature-file">Temperature log (.txt)</label>
        <input type="file" id="import-temperature-file" accept=".txt,text/plain" />
        <p id="import-temperature-status" class="import-status"></p>
        <div id="import-temperature-preview" class="import-preview" hidden>
          <p id="import-temperature-summary"></p>
          <div class="field">
            <label for="heatwave-threshold-input">Flag days above this value as a "Heatwave" factor (optional)</label>
            <input type="number" id="heatwave-threshold-input" step="0.1" placeholder="e.g. 25" />
            <p id="heatwave-threshold-preview" class="export-note" style="margin-top: 0.4rem"></p>
          </div>
          <button type="button" id="import-temperature-confirm-btn" class="primary-btn">Import</button>
        </div>
      </div>

      <hr class="section-divider" />
      <h2 class="section-heading">Import Factor Log</h2>
      <p class="export-note" style="margin-top: 0">
        One entry per line: a date and a factor name (e.g. "2026-07-21 period"), or a range on one
        line (e.g. "2026-07-21 to 2026-07-25 period") to log every day in between. Existing factor
        names are reused; new ones are created automatically.
      </p>
      <div class="field">
        <label for="import-factorlog-file">Factor log (.txt)</label>
        <input type="file" id="import-factorlog-file" accept=".txt,text/plain" />
        <p id="import-factorlog-status" class="import-status"></p>
        <div id="import-factorlog-preview" class="import-preview" hidden>
          <div class="factorlog-import-mode-row import-mode-row chip-row">
            <button type="button" class="chip" data-import-mode="append" aria-pressed="true">Append</button>
            <button type="button" class="chip" data-import-mode="replace" aria-pressed="false">Replace All</button>
          </div>
          <p id="import-factorlog-summary"></p>
          <button type="button" id="import-factorlog-confirm-btn" class="primary-btn">Import</button>
        </div>
      </div>
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
    container.querySelectorAll("#import-structured-preview .import-mode-row .chip").forEach((chip) => {
      chip.addEventListener("click", async () => {
        structuredImportMode = chip.dataset.importMode;
        syncStructuredImportModeChips();
        await renderStructuredImportSummary();
      });
    });

    container.querySelector("#import-text-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleTextFile(file);
    });
    container.querySelector("#import-candidates-confirm-btn").addEventListener("click", confirmCandidateImport);

    container.querySelector("#import-temperature-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleTemperatureFile(file);
    });
    container.querySelector("#heatwave-threshold-input").addEventListener("input", renderHeatwaveThresholdPreview);
    container.querySelector("#import-temperature-confirm-btn").addEventListener("click", confirmTemperatureImport);

    container.querySelector("#import-factorlog-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleFactorLogFile(file);
    });
    container.querySelector("#import-factorlog-confirm-btn").addEventListener("click", confirmFactorLogImport);
    container.querySelectorAll(".factorlog-import-mode-row .chip").forEach((chip) => {
      chip.addEventListener("click", async () => {
        factorLogImportMode = chip.dataset.importMode;
        syncFactorLogImportModeChips();
        await renderFactorLogSummary();
      });
    });

    container.querySelectorAll("#tag-manage-sort-row .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        tagManageSortMode = chip.dataset.sort;
        syncTagManageSortChips();
        renderTagManageList();
      });
    });

    await loadExportSummary();
    await loadPickerData();
    await loadTagUsage();
    await loadConditionUsage();
    renderTagManageList();
    renderConditionManageList();
    renderFactorManageList();
  }

  async function onShow() {
    await loadExportSummary();
    await loadPickerData();
    await loadTagUsage();
    await loadConditionUsage();
    renderTagManageList();
    renderConditionManageList();
    renderFactorManageList();
  }

  return { init, onShow };
})();

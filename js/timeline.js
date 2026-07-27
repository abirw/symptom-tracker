/**
 * Timeline view: a GitHub-style contribution heatmap sitting above a
 * reverse-chronological entry list, both driven by the same tag/condition
 * filters. Tapping a heatmap day narrows the list to that date; tapping a
 * list entry opens a bottom-sheet modal for editing or deleting it.
 *
 * The modal's Tags field is TagPickerField (tag-picker-field.js), shared
 * with the Log screen so the classic-vs-smart toggle behaves identically
 * in both places - same for the Trigger Tags field, wired to DB.touchTrigger/
 * getAllTriggers instead. The Awareness Level/Time of Day option lists
 * (AWARENESS_LEVELS/TIME_OF_DAY_OPTIONS) live on LogView, not here, since
 * Log is the screen that defines them.
 */
const TimelineView = (() => {
  const HEATMAP_WEEKS = 52;

  let container;
  let entries = [];
  let tags = [];
  let conditions = [];
  let triggers = [];
  let filterTag = "";
  let filterCondition = "";
  let selectedDay = null; // "YYYY-MM-DD" from tapping a heatmap cell, or null
  let heatmapScrollInitialized = false;

  let editingEntry = null;
  let editSelectedTags = new Set(); // never reassigned - .clear()'d, so TagPickerField's reference stays valid
  let editSelectedConditions = new Set();
  let editSelectedSeverity = null;
  let editSelectedAwareness = null;
  let editSelectedTimeOfDay = null;
  let editSelectedTriggerTags = new Set(); // never reassigned, same reasoning as editSelectedTags
  let deleteArmed = false; // first Delete tap arms it; a second tap actually deletes (see handleDelete)
  let modalTagField = null;
  let modalTriggerField = null;
  let modalSuggestionDebounceTimer = null;

  function render() {
    container.innerHTML = `
      <div class="filter-bar">
        <select id="filter-tag"></select>
        <select id="filter-condition"></select>
      </div>

      <div class="heatmap-card">
        <div class="heatmap-mode-row chip-row">
          <button type="button" class="chip" data-heatmap-mode="frequency">Frequency</button>
          <button type="button" class="chip" data-heatmap-mode="avgSeverity">Avg severity</button>
          <button type="button" class="chip" data-heatmap-mode="maxSeverity">Max severity</button>
        </div>
        <div class="heatmap-scroll">
          <div id="heatmap-months" class="heatmap-months"></div>
          <div id="heatmap-grid" class="heatmap-grid"></div>
        </div>
        <div id="heatmap-legend" class="heatmap-legend"></div>
      </div>

      <p id="day-filter-note" class="day-filter-note" hidden></p>

      <div id="timeline-list" class="timeline-list"></div>

      <div id="entry-modal" class="modal-overlay">
        <div class="modal-sheet">
          <div class="modal-header">
            <button type="button" id="modal-close-btn" class="modal-header-btn">Cancel</button>
            <h2>Edit Entry</h2>
            <button type="button" id="modal-delete-btn" class="modal-header-btn modal-delete">Delete</button>
          </div>
          <form id="modal-form">
            <div class="field">
              <label>Tags</label>
              <div id="modal-tags-field"></div>
            </div>
            <div class="field">
              <label>Conditions</label>
              <div id="modal-condition-chips" class="chip-row"></div>
              <div class="add-row">
                <input type="text" id="modal-new-condition-input" placeholder="Add condition…" autocomplete="off" />
                <button type="button" id="modal-add-condition-btn">Add</button>
              </div>
            </div>
            <div class="field">
              <label>Severity</label>
              <div id="modal-severity-row" class="severity-row"></div>
            </div>
            <div class="field">
              <label>Duration</label>
              <div class="duration-row">
                <input type="number" id="modal-duration-input" min="0" placeholder="Minutes" />
                <label class="duration-estimated-label">
                  <input type="checkbox" id="modal-duration-estimated-input" /> Estimated
                </label>
              </div>
            </div>
            <div class="field">
              <label>Awareness Level</label>
              <div id="modal-awareness-row" class="chip-row"></div>
            </div>
            <div class="field">
              <label>Time of Day</label>
              <div id="modal-time-of-day-row" class="chip-row"></div>
            </div>
            <div class="field">
              <label>Trigger Tags</label>
              <div id="modal-triggers-field"></div>
            </div>
            <div class="field">
              <label for="modal-note-input">Note</label>
              <textarea id="modal-note-input" rows="4"></textarea>
            </div>
            <div class="field">
              <label for="modal-timestamp-input">Time</label>
              <input type="datetime-local" id="modal-timestamp-input" />
            </div>
            <button type="submit" class="primary-btn">Save Changes</button>
          </form>
        </div>
      </div>
    `;
  }

  function populateFilterOptions() {
    const tagSelect = container.querySelector("#filter-tag");
    const condSelect = container.querySelector("#filter-condition");

    tagSelect.innerHTML = "";
    const allTagsOpt = document.createElement("option");
    allTagsOpt.value = "";
    allTagsOpt.textContent = "All tags";
    tagSelect.appendChild(allTagsOpt);
    tags
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.name;
        opt.textContent = t.name;
        tagSelect.appendChild(opt);
      });
    tagSelect.value = filterTag;

    condSelect.innerHTML = "";
    const allCondOpt = document.createElement("option");
    allCondOpt.value = "";
    allCondOpt.textContent = "All conditions";
    condSelect.appendChild(allCondOpt);
    conditions
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.name;
        opt.textContent = c.name;
        condSelect.appendChild(opt);
      });
    condSelect.value = filterCondition;
  }

  // --- Shared tag/condition filtering (heatmap + list both respect these) ---

  /** Entries matching the tag/condition filters only — the heatmap always shows this set. */
  function getTagConditionFiltered() {
    return entries
      .filter((e) => !filterTag || e.tags.includes(filterTag))
      .filter((e) => !filterCondition || (e.conditions || []).includes(filterCondition));
  }

  /** Same as above, plus the heatmap day filter if one's selected — this is what the list shows. */
  function getFilteredEntries() {
    let list = getTagConditionFiltered();
    if (selectedDay) {
      list = list.filter((e) => dateKey(new Date(e.timestamp)) === selectedDay);
    }
    return list.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  function formatDateTime(iso) {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // --- Heatmap ---

  /** Local (not UTC) YYYY-MM-DD key, used to group entries by calendar day. */
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function startOfWeekSun(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  /** Builds HEATMAP_WEEKS weeks of 7 days each, ending on the week containing today. */
  function buildHeatmapWeeks() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstWeekStart = startOfWeekSun(today);
    firstWeekStart.setDate(firstWeekStart.getDate() - (HEATMAP_WEEKS - 1) * 7);

    const weeks = [];
    for (let w = 0; w < HEATMAP_WEEKS; w++) {
      const weekStart = new Date(firstWeekStart);
      weekStart.setDate(weekStart.getDate() + w * 7);
      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(weekStart);
        date.setDate(date.getDate() + d);
        days.push(date);
      }
      weeks.push(days);
    }
    return weeks;
  }

  /** Maps a raw entry count to one of the heatmap's frequency-mode color levels (0-4). */
  function levelForCount(count) {
    if (count <= 0) return 0;
    if (count === 1) return 1;
    if (count === 2) return 2;
    if (count === 3) return 3;
    return 4;
  }

  /** Per-day entry count + severities (whichever the current color mode needs), keyed by dateKey. */
  function computeHeatmapDayStats() {
    const stats = new Map();
    getTagConditionFiltered().forEach((e) => {
      const key = dateKey(new Date(e.timestamp));
      if (!stats.has(key)) stats.set(key, { count: 0, severities: [] });
      const day = stats.get(key);
      day.count++;
      if (e.severity != null) day.severities.push(e.severity);
    });
    return stats;
  }

  /**
   * Resolves one day's color level + tooltip for the current heatmap color
   * mode. Frequency reuses the existing 0-4 count-based levels; the two
   * severity modes reuse the app's 1-5 severity color scale directly (level
   * 0 means no severity was logged that day, distinct from no entries at all).
   */
  function describeHeatmapDay(stats, mode, dateLabel) {
    const count = stats ? stats.count : 0;
    const entryWord = count === 1 ? "entry" : "entries";

    if (mode === "frequency") {
      return { attr: "level", level: levelForCount(count), title: `${count} ${entryWord} on ${dateLabel}` };
    }

    const severities = stats ? stats.severities : [];
    if (severities.length === 0) {
      const suffix = count > 0 ? ` (${count} ${entryWord}, no severity logged)` : "";
      return { attr: "sevLevel", level: 0, title: `No severity data on ${dateLabel}${suffix}` };
    }

    const value =
      mode === "avgSeverity" ? severities.reduce((a, b) => a + b, 0) / severities.length : Math.max(...severities);
    const level = Math.max(1, Math.min(5, Math.round(value)));
    const label = mode === "avgSeverity" ? "avg severity" : "max severity";
    const valueLabel = mode === "avgSeverity" ? value.toFixed(1) : String(value);
    return { attr: "sevLevel", level, title: `${label} ${valueLabel} (${count} ${entryWord}) on ${dateLabel}` };
  }

  /** Rebuilds the "Less/More" or "Mild/Severe" legend swatches to match the current color mode. */
  function renderHeatmapLegend() {
    const legendEl = container.querySelector("#heatmap-legend");
    const mode = Settings.get("heatmapColorMode");
    legendEl.innerHTML = "";

    const startLabel = document.createElement("span");
    const endLabel = document.createElement("span");
    const swatchCount = mode === "frequency" ? 5 : 6; // frequency: levels 0-4; severity: levels 0-5
    const attr = mode === "frequency" ? "level" : "sevLevel";

    if (mode === "frequency") {
      startLabel.textContent = "Less";
      endLabel.textContent = "More";
    } else {
      startLabel.textContent = "Mild";
      endLabel.textContent = "Severe";
    }

    legendEl.appendChild(startLabel);
    for (let i = 0; i < swatchCount; i++) {
      const swatch = document.createElement("span");
      swatch.className = "heatmap-day";
      swatch.dataset[attr] = String(i);
      legendEl.appendChild(swatch);
    }
    legendEl.appendChild(endLabel);
  }

  /** Keeps the Frequency/Avg severity/Max severity chips in sync with the current color mode. */
  function syncHeatmapModeChips() {
    const mode = Settings.get("heatmapColorMode");
    container.querySelectorAll(".heatmap-mode-row .chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", chip.dataset.heatmapMode === mode ? "true" : "false");
    });
  }

  /** Shows/hides the "Showing <date> only · Clear" banner above the list. */
  function renderDayFilterNote() {
    const noteEl = container.querySelector("#day-filter-note");
    if (!selectedDay) {
      noteEl.hidden = true;
      noteEl.innerHTML = "";
      return;
    }
    noteEl.hidden = false;
    noteEl.innerHTML = "";

    const label = document.createElement("span");
    const [y, m, d] = selectedDay.split("-").map(Number);
    label.textContent = `Showing ${new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })} only`;

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      selectedDay = null;
      renderHeatmap();
      renderDayFilterNote();
      renderList();
    });

    noteEl.appendChild(label);
    noteEl.appendChild(clearBtn);
  }

  /** Rebuilds the full heatmap grid + month labels from the current tag/condition filters and color mode. */
  function renderHeatmap() {
    const gridEl = container.querySelector("#heatmap-grid");
    const monthsEl = container.querySelector("#heatmap-months");
    gridEl.innerHTML = "";
    monthsEl.innerHTML = "";

    syncHeatmapModeChips();
    renderHeatmapLegend();

    const mode = Settings.get("heatmapColorMode");
    const weeks = buildHeatmapWeeks();
    const dayStats = computeHeatmapDayStats();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let lastMonthKey = null;

    weeks.forEach((week) => {
      // Label a column only when it contains the 1st-7th of a new month, GitHub-style.
      const firstOfMonthDay = week.find((d) => d.getDate() <= 7);
      const monthLabel = document.createElement("span");
      monthLabel.className = "heatmap-month-label";
      if (firstOfMonthDay) {
        const monthKey = `${firstOfMonthDay.getFullYear()}-${firstOfMonthDay.getMonth()}`;
        if (monthKey !== lastMonthKey) {
          monthLabel.textContent = firstOfMonthDay.toLocaleDateString(undefined, { month: "short" });
          lastMonthKey = monthKey;
        }
      }
      monthsEl.appendChild(monthLabel);

      const col = document.createElement("div");
      col.className = "heatmap-week";

      week.forEach((date) => {
        const key = dateKey(date);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "heatmap-day";

        if (date > today) {
          // Future days within the current week: render as empty, non-interactive spacers.
          btn.classList.add("heatmap-day-empty");
          btn.disabled = true;
        } else {
          const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
          const { attr, level, title } = describeHeatmapDay(dayStats.get(key), mode, dateLabel);
          btn.dataset[attr] = String(level);
          btn.title = title;
          if (key === selectedDay) btn.classList.add("heatmap-day-selected");
          btn.addEventListener("click", () => {
            selectedDay = selectedDay === key ? null : key; // tap again to clear
            renderHeatmap();
            renderDayFilterNote();
            renderList();
          });
        }

        col.appendChild(btn);
      });

      gridEl.appendChild(col);
    });

    // Scroll to the most recent week by default, but only the first time this
    // ever renders - later re-renders (a day tap, a filter change, saving an
    // edit) would otherwise yank the view back to today every time, undoing
    // any side-scrolling the user just did.
    if (!heatmapScrollInitialized) {
      const scrollWrap = container.querySelector(".heatmap-scroll");
      scrollWrap.scrollLeft = scrollWrap.scrollWidth;
      heatmapScrollInitialized = true;
    }
  }

  // --- Entry list ---

  function renderList() {
    const listEl = container.querySelector("#timeline-list");
    listEl.innerHTML = "";
    const filtered = getFilteredEntries();

    if (filtered.length === 0) {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent =
        entries.length === 0 ? "No entries yet — log your first one." : "No entries match these filters.";
      listEl.appendChild(p);
      return;
    }

    filtered.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "timeline-item";
      item.dataset.id = entry.id;

      const header = document.createElement("div");
      header.className = "timeline-item-header";

      const date = document.createElement("span");
      date.className = "timeline-date";
      date.textContent = formatDateTime(entry.timestamp);
      header.appendChild(date);

      if (entry.severity) {
        const sev = document.createElement("span");
        sev.className = "severity-badge";
        sev.dataset.severity = String(entry.severity);
        sev.textContent = `Sev ${entry.severity}`;
        header.appendChild(sev);
      }

      item.appendChild(header);

      if ((entry.tags && entry.tags.length) || (entry.conditions && entry.conditions.length) || (entry.triggerTags && entry.triggerTags.length)) {
        const tagRow = document.createElement("div");
        tagRow.className = "timeline-item-tags";
        (entry.tags || []).forEach((name) => {
          const chip = document.createElement("span");
          chip.className = "chip chip-static";
          chip.textContent = name;
          tagRow.appendChild(chip);
        });
        (entry.conditions || []).forEach((name) => {
          const condChip = document.createElement("span");
          condChip.className = "chip chip-static chip-condition";
          condChip.textContent = name;
          tagRow.appendChild(condChip);
        });
        (entry.triggerTags || []).forEach((name) => {
          const triggerChip = document.createElement("span");
          triggerChip.className = "chip chip-static chip-trigger";
          triggerChip.textContent = name;
          tagRow.appendChild(triggerChip);
        });
        item.appendChild(tagRow);
      }

      const detailParts = [];
      if (entry.durationMinutes != null) {
        detailParts.push(`${entry.durationMinutes} min${entry.durationEstimated ? " (est.)" : ""}`);
      }
      if (entry.awarenessLevel) {
        const level = LogView.AWARENESS_LEVELS.find((l) => l.value === entry.awarenessLevel);
        detailParts.push(level ? level.label : entry.awarenessLevel);
      }
      if (entry.timeOfDay) {
        const tod = LogView.TIME_OF_DAY_OPTIONS.find((t) => t.value === entry.timeOfDay);
        detailParts.push(tod ? tod.label : entry.timeOfDay);
      }
      if (detailParts.length > 0) {
        const detail = document.createElement("div");
        detail.className = "timeline-item-detail";
        detail.textContent = detailParts.join(" · ");
        item.appendChild(detail);
      }

      if (entry.note) {
        const note = document.createElement("div");
        note.className = "timeline-item-note";
        note.textContent = entry.note;
        item.appendChild(note);
      }

      item.addEventListener("click", () => openEntry(entry.id));
      listEl.appendChild(item);
    });
  }

  async function loadData() {
    [entries, tags, conditions, triggers] = await Promise.all([
      DB.getAllEntries(),
      DB.getAllTags(),
      DB.getAllConditions(),
      DB.getAllTriggers(),
    ]);
    populateFilterOptions();
    // Also refresh the edit modal's pickers here, not just in openEntry(): if
    // the modal was left open when the user switched tabs (it isn't actually
    // torn down, just hidden along with the rest of this view), returning to
    // Timeline would otherwise leave it showing whatever tags/conditions
    // existed the last time it was rendered, even after a fresh loadData().
    if (modalTagField) modalTagField.render();
    if (modalTriggerField) modalTriggerField.render();
    renderModalConditionAndSeverity();
    renderHeatmap();
    renderDayFilterNote();
    renderList();
  }

  /** Renders the modal's Condition + Severity + Awareness + Time of Day pickers (Tags is handled separately by modalTagField). */
  function renderModalConditionAndSeverity() {
    Pickers.renderConditionChips(container.querySelector("#modal-condition-chips"), conditions, editSelectedConditions, (name) => {
      if (editSelectedConditions.has(name)) {
        editSelectedConditions.delete(name);
      } else {
        editSelectedConditions.add(name);
      }
      maybeRefreshModalSuggestions();
    });
    Pickers.renderSeverity(
      container.querySelector("#modal-severity-row"),
      () => editSelectedSeverity,
      (val) => {
        editSelectedSeverity = editSelectedSeverity === val ? null : val;
      }
    );
    Pickers.renderSingleSelectChips(
      container.querySelector("#modal-awareness-row"),
      LogView.AWARENESS_LEVELS,
      () => editSelectedAwareness,
      (val) => {
        editSelectedAwareness = val;
      }
    );
    Pickers.renderSingleSelectChips(
      container.querySelector("#modal-time-of-day-row"),
      LogView.TIME_OF_DAY_OPTIONS,
      () => editSelectedTimeOfDay,
      (val) => {
        editSelectedTimeOfDay = val;
      }
    );
  }

  /** Recomputes the modal's tag suggestions if smart mode is active; safe to call before init() completes. */
  function maybeRefreshModalSuggestions() {
    if (modalTagField) modalTagField.refreshSuggestions();
  }

  /** Same as handleModalAddTag used to be, for conditions (tags are now handled by modalTagField). */
  async function handleModalAddCondition() {
    const input = container.querySelector("#modal-new-condition-input");
    const name = input.value.trim();
    if (!name) return;

    const timestampInput = container.querySelector("#modal-timestamp-input").value;
    const occurredAt = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();

    const cond = await DB.touchCondition(name, occurredAt);
    if (!conditions.some((c) => c.name === cond.name)) {
      conditions.push(cond);
    }
    editSelectedConditions.add(cond.name);
    input.value = "";
    renderModalConditionAndSeverity();
    populateFilterOptions();
    maybeRefreshModalSuggestions();
  }

  /** Opens the edit modal pre-filled with `id`'s current values. */
  function openEntry(id) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;

    editingEntry = entry;
    editSelectedTags.clear();
    (entry.tags || []).forEach((t) => editSelectedTags.add(t));
    editSelectedConditions = new Set(entry.conditions || []);
    editSelectedSeverity = entry.severity ?? null;
    editSelectedAwareness = entry.awarenessLevel ?? null;
    editSelectedTimeOfDay = entry.timeOfDay ?? null;
    editSelectedTriggerTags.clear();
    (entry.triggerTags || []).forEach((t) => editSelectedTriggerTags.add(t));

    container.querySelector("#modal-note-input").value = entry.note || "";
    container.querySelector("#modal-timestamp-input").value = DateUtils.toLocalInputValue(entry.timestamp);
    container.querySelector("#modal-duration-input").value = entry.durationMinutes != null ? String(entry.durationMinutes) : "";
    container.querySelector("#modal-duration-estimated-input").checked = Boolean(entry.durationEstimated);

    if (modalTagField) modalTagField.render();
    if (modalTriggerField) modalTriggerField.render();
    renderModalConditionAndSeverity();
    resetDeleteArm();
    container.querySelector("#entry-modal").classList.add("is-open");
  }

  function closeModal() {
    editingEntry = null;
    resetDeleteArm();
    container.querySelector("#entry-modal").classList.remove("is-open");
  }

  async function handleModalSubmit(event) {
    event.preventDefault();
    if (!editingEntry) return;

    const submitBtn = container.querySelector('#modal-form button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const note = container.querySelector("#modal-note-input").value.trim();
      const timestampInput = container.querySelector("#modal-timestamp-input").value;
      const timestamp = timestampInput ? new Date(timestampInput).toISOString() : editingEntry.timestamp;
      const durationRaw = container.querySelector("#modal-duration-input").value;
      const durationMinutes = durationRaw === "" ? null : Number(durationRaw);
      const durationEstimated = container.querySelector("#modal-duration-estimated-input").checked;

      // Corrects firstUsed/createdAt backwards if the timestamp was edited to
      // something earlier than a selected tag/condition/trigger's known start.
      for (const name of editSelectedTags) {
        await DB.touchTag(name, timestamp);
      }
      for (const name of editSelectedConditions) {
        await DB.touchCondition(name, timestamp);
      }
      for (const name of editSelectedTriggerTags) {
        await DB.touchTrigger(name, timestamp);
      }

      const updated = {
        ...editingEntry,
        timestamp,
        tags: Array.from(editSelectedTags),
        conditions: Array.from(editSelectedConditions),
        severity: editSelectedSeverity,
        note,
        durationMinutes,
        durationEstimated,
        awarenessLevel: editSelectedAwareness,
        timeOfDay: editSelectedTimeOfDay,
        triggerTags: Array.from(editSelectedTriggerTags),
      };

      await DB.updateEntry(updated);

      const idx = entries.findIndex((e) => e.id === updated.id);
      if (idx !== -1) entries[idx] = updated;

      closeModal();
      renderHeatmap();
      renderList();
    } finally {
      submitBtn.disabled = false;
    }
  }

  function resetDeleteArm() {
    deleteArmed = false;
    const btn = container.querySelector("#modal-delete-btn");
    if (btn) btn.textContent = "Delete";
  }

  /**
   * Two-tap in-page confirmation instead of window.confirm(): standalone
   * iOS home-screen PWAs don't show native confirm/alert/prompt dialogs at
   * all (the call just returns falsy immediately), so `if (!confirm(...))
   * return` would silently no-op every time - exactly like "does nothing".
   * The first tap re-labels the button as a warning; only a second tap
   * within the same session actually deletes.
   */
  async function handleDelete() {
    if (!editingEntry) return;
    const btn = container.querySelector("#modal-delete-btn");

    if (!deleteArmed) {
      deleteArmed = true;
      btn.textContent = "Confirm Delete?";
      return;
    }

    await DB.deleteEntry(editingEntry.id);
    entries = entries.filter((e) => e.id !== editingEntry.id);

    resetDeleteArm();
    closeModal();
    renderHeatmap();
    renderList();
  }

  async function init() {
    container = document.getElementById("view-timeline");
    render();

    container.querySelector("#filter-tag").addEventListener("change", (e) => {
      filterTag = e.target.value;
      renderHeatmap();
      renderList();
    });
    container.querySelector("#filter-condition").addEventListener("change", (e) => {
      filterCondition = e.target.value;
      renderHeatmap();
      renderList();
    });

    container.querySelectorAll(".heatmap-mode-row .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        Settings.set("heatmapColorMode", chip.dataset.heatmapMode);
        renderHeatmap(); // also re-syncs the mode chips + legend
      });
    });

    modalTagField = TagPickerField.create(container.querySelector("#modal-tags-field"), {
      selectedTags: editSelectedTags,
      getAllTags: () => tags,
      getAllEntries: () => entries,
      getSelectedConditions: () => editSelectedConditions,
      getNoteText: () => container.querySelector("#modal-note-input").value,
      createTag: async (name) => {
        const timestampInput = container.querySelector("#modal-timestamp-input").value;
        const occurredAt = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();
        const tag = await DB.touchTag(name, occurredAt);
        if (!tags.some((t) => t.name === tag.name)) tags.push(tag);
        populateFilterOptions(); // so the new tag is immediately available as a filter too
        return tag;
      },
    });

    modalTriggerField = TagPickerField.create(container.querySelector("#modal-triggers-field"), {
      selectedTags: editSelectedTriggerTags,
      getAllTags: () => triggers,
      getAllEntries: () => entries,
      getSelectedConditions: () => editSelectedConditions,
      getNoteText: () => container.querySelector("#modal-note-input").value,
      createTag: async (name) => {
        const timestampInput = container.querySelector("#modal-timestamp-input").value;
        const occurredAt = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();
        const trigger = await DB.touchTrigger(name, occurredAt);
        if (!triggers.some((t) => t.name === trigger.name)) triggers.push(trigger);
        return trigger;
      },
    });

    const modal = container.querySelector("#entry-modal");
    container.querySelector("#modal-close-btn").addEventListener("click", closeModal);
    container.querySelector("#modal-delete-btn").addEventListener("click", handleDelete);
    container.querySelector("#modal-form").addEventListener("submit", handleModalSubmit);
    container.querySelector("#modal-add-condition-btn").addEventListener("click", handleModalAddCondition);
    container.querySelector("#modal-new-condition-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleModalAddCondition();
      }
    });
    container.querySelector("#modal-note-input").addEventListener("input", () => {
      clearTimeout(modalSuggestionDebounceTimer);
      modalSuggestionDebounceTimer = setTimeout(maybeRefreshModalSuggestions, 250);
    });
    // Tapping the dimmed backdrop (not the sheet itself) closes the modal, like a native sheet.
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("is-open")) closeModal();
    });

    await loadData();
  }

  /** Called by the Settings modal when the tag picker mode changes; safe to call even before init(). */
  function refreshTagPicker() {
    if (modalTagField) modalTagField.render();
    if (modalTriggerField) modalTriggerField.render();
  }

  return { init, onShow: loadData, refreshTagPicker };
})();

/**
 * Timeline view: a GitHub-style contribution heatmap sitting above a
 * reverse-chronological entry list, both driven by the same tag/condition
 * filters. Tapping a heatmap day narrows the list to that date; tapping a
 * list entry opens a bottom-sheet modal for editing or deleting it.
 */
const TimelineView = (() => {
  const HEATMAP_WEEKS = 52;

  let container;
  let entries = [];
  let tags = [];
  let conditions = [];
  let filterTag = "";
  let filterCondition = "";
  let selectedDay = null; // "YYYY-MM-DD" from tapping a heatmap cell, or null

  let editingEntry = null;
  let editSelectedTags = new Set();
  let editSelectedConditions = new Set();
  let editSelectedSeverity = null;

  function render() {
    container.innerHTML = `
      <div class="filter-bar">
        <select id="filter-tag"></select>
        <select id="filter-condition"></select>
      </div>

      <div class="heatmap-card">
        <div class="heatmap-scroll">
          <div id="heatmap-months" class="heatmap-months"></div>
          <div id="heatmap-grid" class="heatmap-grid"></div>
        </div>
        <div class="heatmap-legend">
          <span>Less</span>
          <span class="heatmap-day" data-level="0"></span>
          <span class="heatmap-day" data-level="1"></span>
          <span class="heatmap-day" data-level="2"></span>
          <span class="heatmap-day" data-level="3"></span>
          <span class="heatmap-day" data-level="4"></span>
          <span>More</span>
        </div>
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
              <div id="modal-tag-chips" class="chip-row"></div>
              <div class="add-row">
                <input type="text" id="modal-new-tag-input" placeholder="Add tag…" autocomplete="off" />
                <button type="button" id="modal-add-tag-btn">Add</button>
              </div>
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

  /** Maps a raw entry count to one of the heatmap's 5 color intensity levels. */
  function levelForCount(count) {
    if (count <= 0) return 0;
    if (count === 1) return 1;
    if (count === 2) return 2;
    if (count === 3) return 3;
    return 4;
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

  /** Rebuilds the full heatmap grid + month labels from the current tag/condition filters. */
  function renderHeatmap() {
    const gridEl = container.querySelector("#heatmap-grid");
    const monthsEl = container.querySelector("#heatmap-months");
    gridEl.innerHTML = "";
    monthsEl.innerHTML = "";

    const weeks = buildHeatmapWeeks();
    const counts = new Map();
    getTagConditionFiltered().forEach((e) => {
      const key = dateKey(new Date(e.timestamp));
      counts.set(key, (counts.get(key) || 0) + 1);
    });

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
          const count = counts.get(key) || 0;
          btn.dataset.level = String(levelForCount(count));
          btn.title = `${count} ${count === 1 ? "entry" : "entries"} on ${date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}`;
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

    // Scroll to the most recent week by default rather than the oldest.
    const scrollWrap = container.querySelector(".heatmap-scroll");
    scrollWrap.scrollLeft = scrollWrap.scrollWidth;
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

      if ((entry.tags && entry.tags.length) || (entry.conditions && entry.conditions.length)) {
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
        item.appendChild(tagRow);
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
    [entries, tags, conditions] = await Promise.all([DB.getAllEntries(), DB.getAllTags(), DB.getAllConditions()]);
    populateFilterOptions();
    renderHeatmap();
    renderDayFilterNote();
    renderList();
  }

  function renderModalPickers() {
    Pickers.renderTagChips(container.querySelector("#modal-tag-chips"), tags, editSelectedTags, (name) => {
      if (editSelectedTags.has(name)) {
        editSelectedTags.delete(name);
      } else {
        editSelectedTags.add(name);
      }
    });
    Pickers.renderConditionChips(container.querySelector("#modal-condition-chips"), conditions, editSelectedConditions, (name) => {
      if (editSelectedConditions.has(name)) {
        editSelectedConditions.delete(name);
      } else {
        editSelectedConditions.add(name);
      }
    });
    Pickers.renderSeverity(
      container.querySelector("#modal-severity-row"),
      () => editSelectedSeverity,
      (val) => {
        editSelectedSeverity = editSelectedSeverity === val ? null : val;
      }
    );
  }

  /**
   * Creates a new tag on the fly from the modal (same pattern as the Log
   * form), using this entry's own timestamp as the tag's firstUsed so
   * backdating still tracks onset correctly.
   */
  async function handleModalAddTag() {
    const input = container.querySelector("#modal-new-tag-input");
    const name = input.value.trim();
    if (!name) return;

    const timestampInput = container.querySelector("#modal-timestamp-input").value;
    const occurredAt = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();

    const tag = await DB.touchTag(name, occurredAt);
    if (!tags.some((t) => t.name === tag.name)) {
      tags.push(tag);
    }
    editSelectedTags.add(tag.name);
    input.value = "";
    renderModalPickers();
    populateFilterOptions(); // so the new tag is immediately available as a filter too
  }

  /** Same as handleModalAddTag, for conditions. */
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
    renderModalPickers();
    populateFilterOptions();
  }

  /** Opens the edit modal pre-filled with `id`'s current values. */
  function openEntry(id) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;

    editingEntry = entry;
    editSelectedTags = new Set(entry.tags || []);
    editSelectedConditions = new Set(entry.conditions || []);
    editSelectedSeverity = entry.severity ?? null;

    container.querySelector("#modal-note-input").value = entry.note || "";
    container.querySelector("#modal-timestamp-input").value = DateUtils.toLocalInputValue(entry.timestamp);

    renderModalPickers();
    container.querySelector("#entry-modal").classList.add("is-open");
  }

  function closeModal() {
    editingEntry = null;
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

      // Corrects firstUsed/createdAt backwards if the timestamp was edited to
      // something earlier than a selected tag/condition's known start.
      for (const name of editSelectedTags) {
        await DB.touchTag(name, timestamp);
      }
      for (const name of editSelectedConditions) {
        await DB.touchCondition(name, timestamp);
      }

      const updated = {
        ...editingEntry,
        timestamp,
        tags: Array.from(editSelectedTags),
        conditions: Array.from(editSelectedConditions),
        severity: editSelectedSeverity,
        note,
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

  async function handleDelete() {
    if (!editingEntry) return;
    if (!confirm("Delete this entry? This can't be undone.")) return;

    await DB.deleteEntry(editingEntry.id);
    entries = entries.filter((e) => e.id !== editingEntry.id);

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

    const modal = container.querySelector("#entry-modal");
    container.querySelector("#modal-close-btn").addEventListener("click", closeModal);
    container.querySelector("#modal-delete-btn").addEventListener("click", handleDelete);
    container.querySelector("#modal-form").addEventListener("submit", handleModalSubmit);
    container.querySelector("#modal-add-tag-btn").addEventListener("click", handleModalAddTag);
    container.querySelector("#modal-new-tag-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleModalAddTag();
      }
    });
    container.querySelector("#modal-add-condition-btn").addEventListener("click", handleModalAddCondition);
    container.querySelector("#modal-new-condition-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleModalAddCondition();
      }
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

  return { init, onShow: loadData };
})();

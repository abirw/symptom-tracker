/**
 * Log Entry screen: the fast-path form for recording a new symptom entry.
 * Tags/conditions are picked from existing chips or typed fresh (created
 * on-the-fly via DB.touchTag/touchCondition) - an entry can have any number
 * of each. Every field except tags is optional per SPEC.md ("never require
 * every field").
 *
 * The Tags field itself is TagPickerField (tag-picker-field.js), shared with
 * Timeline's edit modal so the classic-vs-smart toggle behaves identically
 * in both places.
 *
 * Below the entry form is a second, independent "Other Factors" section for
 * logging non-symptom things (period, heatwaves, medication changes) that
 * might explain symptom patterns. These are deliberately a separate log
 * (DB.factors/factorEntries), not attached to a symptom entry - a multi-day
 * period is logged as one factor entry per day, the same way a run of
 * distinct same-day symptom entries is already how this app models repeated
 * episodes, rather than as a date range.
 *
 * Occurrences: when a single entry actually represents more than one
 * occurrence (e.g. "had stomach drop twice before bed"), the Occurrences
 * stepper (default 1) records that count on the entry itself instead of
 * requiring N separate near-duplicate entries - Analysis weights its
 * tally/average functions by this count (js/analysis.js has the full list
 * of which ones do and which deliberately don't).
 */
const AWARENESS_LEVELS = [
  { value: "alert", label: "Alert" },
  { value: "drowsy", label: "Drowsy" },
  { value: "disoriented", label: "Disoriented" },
  { value: "semi-conscious", label: "Semi-conscious" },
  { value: "unconscious", label: "Unconscious" },
];
const TIME_OF_DAY_OPTIONS = [
  { value: "on-wake", label: "On Waking" },
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "evening", label: "Evening" },
  { value: "on-sleep", label: "On Falling Asleep" },
  { value: "during-sleep", label: "During Sleep" },
];

const LogView = (() => {
  let container;
  let selectedTags = new Set(); // never reassigned - .clear()'d, so TagPickerField's reference stays valid
  let selectedConditions = new Set();
  let selectedSeverity = null;
  let selectedOccurrenceCount = 1; // never 0/null - a logged entry always represents at least 1 occurrence
  let selectedAwareness = null;
  let selectedTimeOfDay = null;
  let selectedTriggerTags = new Set(); // never reassigned, same reasoning as selectedTags
  let allTags = [];
  let allConditions = [];
  let allTriggers = [];
  let allEntries = [];
  let confirmationTimer = null;
  let suggestionDebounceTimer = null;
  let tagField = null;
  let triggerField = null;

  let selectedFactor = new Set(); // at most 1 entry - single-select via clear-then-add, like Reports' symptom picker
  let allFactors = [];
  let allFactorEntries = [];
  let factorConfirmationTimer = null;
  let armedFactorEntryId = null; // two-tap delete: first tap arms this row, a second tap on the same row deletes

  function render() {
    container.innerHTML = `
      <form id="log-form" class="log-form">
        <div class="field">
          <label>Tags</label>
          <div id="tags-field"></div>
        </div>

        <div class="field">
          <label>Condition</label>
          <div id="condition-chips" class="chip-row"></div>
          <div class="add-row">
            <input type="text" id="new-condition-input" placeholder="Add condition…" autocomplete="off" />
            <button type="button" id="add-condition-btn">Add</button>
          </div>
        </div>

        <div class="field">
          <label>Severity</label>
          <div id="severity-row" class="severity-row"></div>
        </div>

        <div class="field">
          <label>Occurrences</label>
          <div class="occurrence-stepper">
            <button type="button" id="occurrence-decrement" class="stepper-btn" aria-label="Decrease occurrences">−</button>
            <span id="occurrence-count-display" class="stepper-value">1</span>
            <button type="button" id="occurrence-increment" class="stepper-btn" aria-label="Increase occurrences">+</button>
          </div>
        </div>

        <div class="field">
          <label>Duration</label>
          <div class="duration-row">
            <input type="number" id="duration-input" min="0" placeholder="Minutes" />
            <label class="duration-estimated-label">
              <input type="checkbox" id="duration-estimated-input" /> Estimated
            </label>
          </div>
        </div>

        <div class="field">
          <label>Awareness Level</label>
          <div id="awareness-row" class="chip-row"></div>
        </div>

        <div class="field">
          <label>Time of Day</label>
          <div id="time-of-day-row" class="chip-row"></div>
        </div>

        <div class="field">
          <label>Trigger Tags</label>
          <div id="triggers-field"></div>
        </div>

        <div class="field">
          <label for="note-input">Note</label>
          <textarea id="note-input" rows="4" placeholder="Optional note…"></textarea>
        </div>

        <div class="field">
          <label for="timestamp-input">Time</label>
          <input type="datetime-local" id="timestamp-input" />
        </div>

        <button type="submit" class="primary-btn">Save Entry</button>
        <p id="save-confirmation" class="confirmation" hidden>✓ Saved</p>
      </form>

      <hr class="section-divider" />
      <h2 class="section-heading">Other Factors</h2>
      <p class="export-note" style="margin-top: 0">
        Non-symptom things that might explain a pattern - period, heatwaves, a new medication.
        Logged separately from entries above; a multi-day factor is logged once per day it's active.
      </p>
      <form id="factor-form" class="log-form">
        <div class="field">
          <label>Factor</label>
          <div id="factor-chips" class="chip-row"></div>
          <div class="add-row">
            <input type="text" id="new-factor-input" placeholder="Add factor…" autocomplete="off" />
            <button type="button" id="add-factor-btn">Add</button>
          </div>
        </div>

        <div class="field">
          <label for="factor-timestamp-input">Time</label>
          <input type="datetime-local" id="factor-timestamp-input" />
        </div>

        <div class="field">
          <label for="factor-note-input">Note</label>
          <textarea id="factor-note-input" rows="2" placeholder="Optional note…"></textarea>
        </div>

        <button type="submit" class="secondary-btn">Log Factor</button>
        <p id="factor-save-confirmation" class="confirmation" hidden>✓ Logged</p>
      </form>
      <div id="recent-factors-list" class="tag-manage-list"></div>
    `;
  }

  function renderConditionChips() {
    Pickers.renderConditionChips(container.querySelector("#condition-chips"), allConditions, selectedConditions, (name) => {
      if (selectedConditions.has(name)) {
        selectedConditions.delete(name);
      } else {
        selectedConditions.add(name);
      }
      maybeRefreshSuggestions();
    });
  }

  function renderSeverity() {
    Pickers.renderSeverity(container.querySelector("#severity-row"), () => selectedSeverity, (val) => {
      selectedSeverity = selectedSeverity === val ? null : val;
    });
  }

  /** Just updates the displayed count and the decrement button's disabled state - the stepper itself isn't rebuilt, unlike the chip rows. */
  function renderOccurrenceCount() {
    container.querySelector("#occurrence-count-display").textContent = String(selectedOccurrenceCount);
    container.querySelector("#occurrence-decrement").disabled = selectedOccurrenceCount <= 1;
  }

  function renderAwareness() {
    Pickers.renderSingleSelectChips(container.querySelector("#awareness-row"), AWARENESS_LEVELS, () => selectedAwareness, (val) => {
      selectedAwareness = val;
    });
  }

  function renderTimeOfDay() {
    Pickers.renderSingleSelectChips(container.querySelector("#time-of-day-row"), TIME_OF_DAY_OPTIONS, () => selectedTimeOfDay, (val) => {
      selectedTimeOfDay = val;
    });
  }

  /** Recomputes tag suggestions if smart mode is active; safe to call before init() completes. */
  function maybeRefreshSuggestions() {
    if (tagField) tagField.refreshSuggestions();
  }

  async function loadPickers() {
    [allTags, allConditions, allEntries, allFactors, allFactorEntries, allTriggers] = await Promise.all([
      DB.getAllTags(),
      DB.getAllConditions(),
      DB.getAllEntries(),
      DB.getAllFactors(),
      DB.getAllFactorEntries(),
      DB.getAllTriggers(),
    ]);
    if (tagField) tagField.render();
    if (triggerField) triggerField.render();
    renderConditionChips();
    renderFactorChips();
    renderRecentFactors();
  }

  async function handleAddCondition() {
    const input = container.querySelector("#new-condition-input");
    const name = input.value.trim();
    if (!name) return;
    const cond = await DB.touchCondition(name);
    if (!allConditions.some((c) => c.name === cond.name)) {
      allConditions.push(cond);
    }
    selectedConditions.add(cond.name);
    input.value = "";
    renderConditionChips();
    maybeRefreshSuggestions();
  }

  /** Clears the form back to its just-opened state after a successful save. */
  function resetForm() {
    selectedTags.clear();
    selectedConditions = new Set();
    selectedSeverity = null;
    selectedOccurrenceCount = 1;
    selectedAwareness = null;
    selectedTimeOfDay = null;
    selectedTriggerTags.clear();
    container.querySelector("#note-input").value = "";
    container.querySelector("#timestamp-input").value = DateUtils.nowForInput();
    container.querySelector("#duration-input").value = "";
    container.querySelector("#duration-estimated-input").checked = false;
    if (tagField) tagField.render();
    if (triggerField) triggerField.render();
    renderConditionChips();
    renderSeverity();
    renderOccurrenceCount();
    renderAwareness();
    renderTimeOfDay();
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const submitBtn = container.querySelector('#log-form button[type="submit"]');
    submitBtn.disabled = true; // guard against a double-tap creating two entries

    try {
      const note = container.querySelector("#note-input").value.trim();
      const timestampInput = container.querySelector("#timestamp-input").value;
      const timestamp = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();
      const durationRaw = container.querySelector("#duration-input").value;
      const durationMinutes = durationRaw === "" ? null : Number(durationRaw);
      const durationEstimated = container.querySelector("#duration-estimated-input").checked;

      // Also corrects a tag/condition/trigger's firstUsed backwards if this
      // entry's (possibly backdated) timestamp predates it - e.g. retroactively
      // logging a new tag for something that happened last week, not today.
      for (const name of selectedTags) {
        await DB.touchTag(name, timestamp);
      }
      for (const name of selectedConditions) {
        await DB.touchCondition(name, timestamp);
      }
      for (const name of selectedTriggerTags) {
        await DB.touchTrigger(name, timestamp);
      }

      await DB.addEntry({
        timestamp,
        tags: Array.from(selectedTags),
        conditions: Array.from(selectedConditions),
        severity: selectedSeverity,
        occurrenceCount: selectedOccurrenceCount,
        note,
        durationMinutes,
        durationEstimated,
        awarenessLevel: selectedAwareness,
        timeOfDay: selectedTimeOfDay,
        triggerTags: Array.from(selectedTriggerTags),
      });

      showConfirmation();
      resetForm();
    } finally {
      submitBtn.disabled = false;
    }
  }

  function showConfirmation() {
    const el = container.querySelector("#save-confirmation");
    el.hidden = false;
    clearTimeout(confirmationTimer);
    confirmationTimer = setTimeout(() => {
      el.hidden = true;
    }, 1500);
  }

  // --- Other Factors ---

  function renderFactorChips() {
    Pickers.renderTagChips(container.querySelector("#factor-chips"), allFactors, selectedFactor, (name) => {
      if (selectedFactor.has(name)) {
        selectedFactor.clear(); // tap the selected chip again to deselect
      } else {
        selectedFactor.clear();
        selectedFactor.add(name);
      }
      // Full re-render, not just the clicked chip: Pickers only flips the
      // button that was actually clicked, but single-select via clear-then-add
      // also needs whichever chip was PREVIOUSLY selected to un-press itself.
      renderFactorChips();
    });
  }

  async function handleAddFactor() {
    const input = container.querySelector("#new-factor-input");
    const name = input.value.trim();
    if (!name) return;
    const factor = await DB.touchFactor(name);
    if (!allFactors.some((f) => f.name === factor.name)) {
      allFactors.push(factor);
    }
    selectedFactor.clear();
    selectedFactor.add(factor.name);
    input.value = "";
    renderFactorChips();
  }

  function resetFactorForm() {
    selectedFactor.clear();
    container.querySelector("#factor-note-input").value = "";
    container.querySelector("#factor-timestamp-input").value = DateUtils.nowForInput();
    renderFactorChips();
  }

  async function handleFactorSubmit(event) {
    event.preventDefault();
    const name = [...selectedFactor][0];
    if (!name) return;

    const submitBtn = container.querySelector('#factor-form button[type="submit"]');
    submitBtn.disabled = true;

    try {
      const note = container.querySelector("#factor-note-input").value.trim();
      const timestampInput = container.querySelector("#factor-timestamp-input").value;
      const timestamp = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();

      await DB.touchFactor(name, timestamp);
      const record = await DB.addFactorEntry({ timestamp, name, note });
      allFactorEntries.push(record);

      showFactorConfirmation();
      resetFactorForm();
      renderRecentFactors();
    } finally {
      submitBtn.disabled = false;
    }
  }

  function showFactorConfirmation() {
    const el = container.querySelector("#factor-save-confirmation");
    el.hidden = false;
    clearTimeout(factorConfirmationTimer);
    factorConfirmationTimer = setTimeout(() => {
      el.hidden = true;
    }, 1500);
  }

  function formatFactorDateTime(iso) {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  /** Reuses Data tab's .tag-manage-row layout for a lightweight name + meta + action-button row. */
  function buildFactorRow(entry) {
    const row = document.createElement("div");
    row.className = "tag-manage-row";

    const info = document.createElement("div");
    info.className = "tag-manage-info";

    const nameEl = document.createElement("span");
    nameEl.className = "tag-manage-name";
    nameEl.textContent = entry.name;
    info.appendChild(nameEl);

    const meta = document.createElement("span");
    meta.className = "tag-manage-meta";
    meta.textContent = entry.note ? `${formatFactorDateTime(entry.timestamp)} · ${entry.note}` : formatFactorDateTime(entry.timestamp);
    info.appendChild(meta);

    row.appendChild(info);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "tag-manage-rename-btn modal-delete";
    deleteBtn.textContent = armedFactorEntryId === entry.id ? "Confirm?" : "Delete";
    deleteBtn.addEventListener("click", () => handleDeleteFactorEntry(entry.id));
    row.appendChild(deleteBtn);

    return row;
  }

  function renderRecentFactors() {
    const wrap = container.querySelector("#recent-factors-list");
    wrap.innerHTML = "";

    const sorted = allFactorEntries.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (sorted.length === 0) {
      const p = document.createElement("p");
      p.className = "placeholder";
      p.textContent = "No factors logged yet.";
      wrap.appendChild(p);
      return;
    }

    sorted.slice(0, 15).forEach((entry) => wrap.appendChild(buildFactorRow(entry)));
  }

  /**
   * Two-tap in-page confirmation, same reasoning as Timeline's entry delete:
   * window.confirm() silently no-ops in an installed iOS home-screen PWA.
   * Only one row can be "armed" at a time - arming a different row's delete
   * disarms whichever was previously armed.
   */
  async function handleDeleteFactorEntry(id) {
    if (armedFactorEntryId !== id) {
      armedFactorEntryId = id;
      renderRecentFactors();
      return;
    }

    await DB.deleteFactorEntry(id);
    allFactorEntries = allFactorEntries.filter((e) => e.id !== id);
    armedFactorEntryId = null;
    renderRecentFactors();
  }

  /** Called by the Settings modal when the tag picker mode changes; safe to call even before init(). */
  function refreshTagPicker() {
    if (tagField) tagField.render();
    if (triggerField) triggerField.render();
  }

  async function init() {
    container = document.getElementById("view-log");
    render();

    tagField = TagPickerField.create(container.querySelector("#tags-field"), {
      selectedTags,
      getAllTags: () => allTags,
      getAllEntries: () => allEntries,
      getSelectedConditions: () => selectedConditions,
      getNoteText: () => container.querySelector("#note-input").value,
      createTag: async (name) => {
        const tag = await DB.touchTag(name);
        if (!allTags.some((t) => t.name === tag.name)) allTags.push(tag);
        return tag;
      },
    });

    triggerField = TagPickerField.create(container.querySelector("#triggers-field"), {
      selectedTags: selectedTriggerTags,
      getAllTags: () => allTriggers,
      getAllEntries: () => allEntries,
      getSelectedConditions: () => selectedConditions,
      getNoteText: () => container.querySelector("#note-input").value,
      createTag: async (name) => {
        const trigger = await DB.touchTrigger(name);
        if (!allTriggers.some((t) => t.name === trigger.name)) allTriggers.push(trigger);
        return trigger;
      },
    });

    container.querySelector("#log-form").addEventListener("submit", handleSubmit);
    container.querySelector("#add-condition-btn").addEventListener("click", handleAddCondition);
    container.querySelector("#new-condition-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddCondition();
      }
    });
    container.querySelector("#note-input").addEventListener("input", () => {
      clearTimeout(suggestionDebounceTimer);
      suggestionDebounceTimer = setTimeout(maybeRefreshSuggestions, 250);
    });
    container.querySelector("#occurrence-decrement").addEventListener("click", () => {
      selectedOccurrenceCount = Math.max(1, selectedOccurrenceCount - 1);
      renderOccurrenceCount();
    });
    container.querySelector("#occurrence-increment").addEventListener("click", () => {
      selectedOccurrenceCount += 1;
      renderOccurrenceCount();
    });

    renderSeverity();
    renderOccurrenceCount();
    renderAwareness();
    renderTimeOfDay();
    container.querySelector("#timestamp-input").value = DateUtils.nowForInput();

    container.querySelector("#factor-form").addEventListener("submit", handleFactorSubmit);
    container.querySelector("#add-factor-btn").addEventListener("click", handleAddFactor);
    container.querySelector("#new-factor-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddFactor();
      }
    });
    container.querySelector("#factor-timestamp-input").value = DateUtils.nowForInput();

    await loadPickers();
  }

  // Re-fetch tags/conditions/entries/factors every time Log is switched back
  // to, not just at first load - otherwise a tag created elsewhere (e.g.
  // Data tab's import) would stay invisible here until a full page reload,
  // since this view's own copies of that data are never told they've gone stale.
  return { init, onShow: loadPickers, refreshTagPicker, AWARENESS_LEVELS, TIME_OF_DAY_OPTIONS };
})();

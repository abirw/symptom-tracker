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
 */
const LogView = (() => {
  let container;
  let selectedTags = new Set(); // never reassigned - .clear()'d, so TagPickerField's reference stays valid
  let selectedConditions = new Set();
  let selectedSeverity = null;
  let allTags = [];
  let allConditions = [];
  let allEntries = [];
  let confirmationTimer = null;
  let suggestionDebounceTimer = null;
  let tagField = null;

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

  /** Recomputes tag suggestions if smart mode is active; safe to call before init() completes. */
  function maybeRefreshSuggestions() {
    if (tagField) tagField.refreshSuggestions();
  }

  async function loadPickers() {
    [allTags, allConditions, allEntries] = await Promise.all([
      DB.getAllTags(),
      DB.getAllConditions(),
      DB.getAllEntries(),
    ]);
    if (tagField) tagField.render();
    renderConditionChips();
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
    container.querySelector("#note-input").value = "";
    container.querySelector("#timestamp-input").value = DateUtils.nowForInput();
    if (tagField) tagField.render();
    renderConditionChips();
    renderSeverity();
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const submitBtn = container.querySelector('button[type="submit"]');
    submitBtn.disabled = true; // guard against a double-tap creating two entries

    try {
      const note = container.querySelector("#note-input").value.trim();
      const timestampInput = container.querySelector("#timestamp-input").value;
      const timestamp = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();

      // Also corrects a tag/condition's firstUsed/createdAt backwards if this
      // entry's (possibly backdated) timestamp predates it - e.g. retroactively
      // logging a new tag for something that happened last week, not today.
      for (const name of selectedTags) {
        await DB.touchTag(name, timestamp);
      }
      for (const name of selectedConditions) {
        await DB.touchCondition(name, timestamp);
      }

      await DB.addEntry({
        timestamp,
        tags: Array.from(selectedTags),
        conditions: Array.from(selectedConditions),
        severity: selectedSeverity,
        note,
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

  /** Called by the Settings modal when the tag picker mode changes; safe to call even before init(). */
  function refreshTagPicker() {
    if (tagField) tagField.render();
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

    renderSeverity();
    container.querySelector("#timestamp-input").value = DateUtils.nowForInput();
    await loadPickers();
  }

  // Re-fetch tags/conditions/entries every time Log is switched back to, not
  // just at first load - otherwise a tag created elsewhere (e.g. Data tab's
  // import) would stay invisible here until a full page reload, since this
  // view's own copies of that data are never told they've gone stale.
  return { init, onShow: loadPickers, refreshTagPicker };
})();

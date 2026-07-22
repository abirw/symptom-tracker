/**
 * Log Entry screen: the fast-path form for recording a new symptom entry.
 * Tags/condition are picked from existing chips or typed fresh (created
 * on-the-fly via DB.touchTag/touchCondition); every field except tags is
 * optional per SPEC.md ("never require every field").
 */
const LogView = (() => {
  let container;
  let selectedTags = new Set();
  let selectedCondition = null;
  let selectedSeverity = null;
  let allTags = [];
  let allConditions = [];
  let confirmationTimer = null;

  function render() {
    container.innerHTML = `
      <form id="log-form" class="log-form">
        <div class="field">
          <label>Tags</label>
          <div id="tag-chips" class="chip-row"></div>
          <div class="add-row">
            <input type="text" id="new-tag-input" placeholder="Add tag…" autocomplete="off" />
            <button type="button" id="add-tag-btn">Add</button>
          </div>
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

  function renderTagChips() {
    Pickers.renderTagChips(container.querySelector("#tag-chips"), allTags, selectedTags, (name) => {
      if (selectedTags.has(name)) {
        selectedTags.delete(name);
      } else {
        selectedTags.add(name);
      }
    });
  }

  function renderConditionChips() {
    Pickers.renderConditionChips(
      container.querySelector("#condition-chips"),
      allConditions,
      () => selectedCondition,
      (name) => {
        selectedCondition = selectedCondition === name ? null : name;
      }
    );
  }

  function renderSeverity() {
    Pickers.renderSeverity(container.querySelector("#severity-row"), () => selectedSeverity, (val) => {
      selectedSeverity = selectedSeverity === val ? null : val;
    });
  }

  /** Local "now", formatted for a `datetime-local` input's value (which ignores timezone offset). */
  function nowForInput() {
    const now = new Date();
    const offsetMs = now.getTimezoneOffset() * 60000;
    return new Date(now.getTime() - offsetMs).toISOString().slice(0, 16);
  }

  async function loadPickers() {
    [allTags, allConditions] = await Promise.all([DB.getAllTags(), DB.getAllConditions()]);
    renderTagChips();
    renderConditionChips();
  }

  /** Clears the form back to its just-opened state after a successful save. */
  function resetForm() {
    selectedTags = new Set();
    selectedCondition = null;
    selectedSeverity = null;
    container.querySelector("#note-input").value = "";
    container.querySelector("#timestamp-input").value = nowForInput();
    renderTagChips();
    renderConditionChips();
    renderSeverity();
  }

  async function handleAddTag() {
    const input = container.querySelector("#new-tag-input");
    const name = input.value.trim();
    if (!name) return;
    const tag = await DB.touchTag(name);
    if (!allTags.some((t) => t.name === tag.name)) {
      allTags.push(tag);
    }
    selectedTags.add(tag.name);
    input.value = "";
    renderTagChips();
  }

  async function handleAddCondition() {
    const input = container.querySelector("#new-condition-input");
    const name = input.value.trim();
    if (!name) return;
    const cond = await DB.touchCondition(name);
    if (!allConditions.some((c) => c.name === cond.name)) {
      allConditions.push(cond);
    }
    selectedCondition = cond.name;
    input.value = "";
    renderConditionChips();
  }

  async function handleSubmit(event) {
    event.preventDefault();

    const submitBtn = container.querySelector('button[type="submit"]');
    submitBtn.disabled = true; // guard against a double-tap creating two entries

    try {
      const note = container.querySelector("#note-input").value.trim();
      const timestampInput = container.querySelector("#timestamp-input").value;
      const timestamp = timestampInput ? new Date(timestampInput).toISOString() : new Date().toISOString();

      // Covers Enter-key selections that never hit the explicit Add button.
      for (const name of selectedTags) {
        await DB.touchTag(name);
      }
      if (selectedCondition) {
        await DB.touchCondition(selectedCondition);
      }

      await DB.addEntry({
        timestamp,
        tags: Array.from(selectedTags),
        condition: selectedCondition,
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

  async function init() {
    container = document.getElementById("view-log");
    render();

    container.querySelector("#log-form").addEventListener("submit", handleSubmit);
    container.querySelector("#add-tag-btn").addEventListener("click", handleAddTag);
    container.querySelector("#add-condition-btn").addEventListener("click", handleAddCondition);
    container.querySelector("#new-tag-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    });
    container.querySelector("#new-condition-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddCondition();
      }
    });

    renderSeverity();
    container.querySelector("#timestamp-input").value = nowForInput();
    await loadPickers();
  }

  return { init };
})();

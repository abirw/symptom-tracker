/**
 * Log Entry screen: the fast-path form for recording a new symptom entry.
 * Tags/conditions are picked from existing chips or typed fresh (created
 * on-the-fly via DB.touchTag/touchCondition) - an entry can have any number
 * of each. Every field except tags is optional per SPEC.md ("never require
 * every field").
 *
 * The Tags field has two interchangeable layouts, chosen by the
 * Settings > "Tag picker style" toggle (see settings.js/app.js):
 *  - "classic": the original full alphabetical chip grid.
 *  - "smart": a searchable/filterable input (better once you have a lot of
 *    tags to scroll through) plus a ranked "Suggested" strip. Suggestions
 *    are a local heuristic only (no AI/network call, matching the
 *    local-first approach already used for Import's text extraction):
 *    tags whose name appears in the note text score highest, tags that
 *    have historically co-occurred with the selected condition(s) score
 *    next, and if neither signal exists yet it falls back to your
 *    overall most-used tags.
 */
const LogView = (() => {
  let container;
  let selectedTags = new Set();
  let selectedConditions = new Set();
  let selectedSeverity = null;
  let allTags = [];
  let allConditions = [];
  let allEntries = [];
  let confirmationTimer = null;
  let suggestionDebounceTimer = null;

  function formShellHtml() {
    return `
      <form id="log-form" class="log-form">
        <div class="field" id="tags-field"></div>

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

  // --- Tags field: classic mode ---

  function classicTagsFieldHtml() {
    return `
      <label>Tags</label>
      <div id="tag-chips" class="chip-row"></div>
      <div class="add-row">
        <input type="text" id="new-tag-input" placeholder="Add tag…" autocomplete="off" />
        <button type="button" id="add-tag-btn">Add</button>
      </div>
    `;
  }

  function renderClassicTagChips() {
    Pickers.renderTagChips(container.querySelector("#tag-chips"), allTags, selectedTags, (name) => {
      if (selectedTags.has(name)) {
        selectedTags.delete(name);
      } else {
        selectedTags.add(name);
      }
    });
  }

  async function createAndSelectTag(name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const tag = await DB.touchTag(trimmed);
    if (!allTags.some((t) => t.name === tag.name)) {
      allTags.push(tag);
    }
    selectedTags.add(tag.name);
  }

  async function handleAddTag() {
    const input = container.querySelector("#new-tag-input");
    await createAndSelectTag(input.value);
    input.value = "";
    renderClassicTagChips();
  }

  function wireClassicTagsField() {
    renderClassicTagChips();
    container.querySelector("#add-tag-btn").addEventListener("click", handleAddTag);
    container.querySelector("#new-tag-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    });
  }

  // --- Tags field: smart search + suggestions mode ---

  function smartTagsFieldHtml() {
    return `
      <label>Tags</label>
      <div id="tag-selected-chips" class="chip-row"></div>
      <div id="tag-suggested-wrap" class="tag-suggested-wrap" hidden>
        <span class="tag-suggested-label">Suggested</span>
        <div id="tag-suggested-chips" class="chip-row"></div>
      </div>
      <div class="tag-search-wrap">
        <input type="text" id="tag-search-input" placeholder="Search or add a tag…" autocomplete="off" />
        <div id="tag-search-results" class="tag-search-results" hidden></div>
      </div>
    `;
  }

  function renderSelectedTagChips() {
    const wrap = container.querySelector("#tag-selected-chips");
    wrap.innerHTML = "";
    Array.from(selectedTags)
      .sort((a, b) => a.localeCompare(b))
      .forEach((name) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.setAttribute("aria-pressed", "true");
        chip.textContent = name;
        chip.addEventListener("click", () => {
          selectedTags.delete(name);
          refreshSmartTagsField();
        });
        wrap.appendChild(chip);
      });
  }

  /**
   * Ranks tags by: (1) appearing in the note text, (2) how often they've
   * co-occurred with the currently-selected condition(s) historically, or
   * (3) overall usage frequency as a fallback when neither signal exists.
   * Pure/local - see the module doc comment above.
   */
  function computeSuggestedTagNames() {
    const noteText = (container.querySelector("#note-input")?.value || "").toLowerCase();
    const conditionNames = Array.from(selectedConditions);
    const scores = new Map();

    allTags.forEach((t) => {
      if (noteText && noteText.includes(t.name.toLowerCase())) {
        scores.set(t.name, (scores.get(t.name) || 0) + 5);
      }
    });

    if (conditionNames.length > 0) {
      allEntries.forEach((e) => {
        if ((e.conditions || []).some((c) => conditionNames.includes(c))) {
          (e.tags || []).forEach((name) => {
            scores.set(name, (scores.get(name) || 0) + 1);
          });
        }
      });
    }

    if (scores.size === 0) {
      allEntries.forEach((e) => (e.tags || []).forEach((name) => scores.set(name, (scores.get(name) || 0) + 1)));
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name)
      .filter((name) => !selectedTags.has(name))
      .slice(0, 8);
  }

  function renderSuggestedTags() {
    const wrap = container.querySelector("#tag-suggested-wrap");
    const chipsWrap = container.querySelector("#tag-suggested-chips");
    const names = computeSuggestedTagNames();

    if (names.length === 0) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;

    const items = names.map((name) => allTags.find((t) => t.name === name)).filter(Boolean);
    Pickers.renderTagChips(
      chipsWrap,
      items,
      selectedTags,
      (name) => {
        selectedTags.add(name); // suggestions only ever show unselected tags, so a tap always adds
        refreshSmartTagsField();
      },
      { sort: false }
    );
  }

  function renderTagSearchResults(query) {
    const resultsEl = container.querySelector("#tag-search-results");
    const q = query.trim().toLowerCase();

    const matches = allTags
      .filter((t) => !selectedTags.has(t.name))
      .filter((t) => !q || t.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 20);

    resultsEl.innerHTML = "";

    matches.forEach((t) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tag-search-result";
      row.textContent = t.name;
      row.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the input so blur doesn't hide this first
      row.addEventListener("click", () => {
        selectedTags.add(t.name);
        clearSearchInput();
        refreshSmartTagsField();
      });
      resultsEl.appendChild(row);
    });

    const hasExactMatch = allTags.some((t) => t.name.toLowerCase() === q);
    if (q && !hasExactMatch) {
      const createRow = document.createElement("button");
      createRow.type = "button";
      createRow.className = "tag-search-result tag-search-create";
      createRow.textContent = `+ Add "${query.trim()}"`;
      createRow.addEventListener("pointerdown", (e) => e.preventDefault());
      createRow.addEventListener("click", async () => {
        await createAndSelectTag(query);
        clearSearchInput();
        refreshSmartTagsField();
      });
      resultsEl.appendChild(createRow);
    }

    resultsEl.hidden = false;
  }

  function clearSearchInput() {
    const input = container.querySelector("#tag-search-input");
    if (input) input.value = "";
  }

  /** Re-renders everything in smart mode that could be stale after a selection/creation. */
  function refreshSmartTagsField() {
    renderSelectedTagChips();
    renderSuggestedTags();
    renderTagSearchResults(container.querySelector("#tag-search-input").value);
  }

  function wireSmartTagsField() {
    renderSelectedTagChips();
    renderSuggestedTags();

    const searchInput = container.querySelector("#tag-search-input");
    const resultsEl = container.querySelector("#tag-search-results");

    searchInput.addEventListener("focus", () => renderTagSearchResults(searchInput.value));
    searchInput.addEventListener("input", () => renderTagSearchResults(searchInput.value));
    searchInput.addEventListener("blur", () => {
      resultsEl.hidden = true;
    });
    searchInput.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = searchInput.value.trim();
      if (!q) return;
      const existing = allTags.find((t) => t.name.toLowerCase() === q.toLowerCase());
      if (existing) {
        selectedTags.add(existing.name);
      } else {
        await createAndSelectTag(q);
      }
      clearSearchInput();
      refreshSmartTagsField();
    });
  }

  // --- Tags field: mode dispatch ---

  function renderTagsField() {
    const mode = Settings.get("tagPickerMode");
    const fieldWrap = container.querySelector("#tags-field");
    fieldWrap.innerHTML = mode === "smart" ? smartTagsFieldHtml() : classicTagsFieldHtml();
    if (mode === "smart") {
      wireSmartTagsField();
    } else {
      wireClassicTagsField();
    }
  }

  /** Called by the Settings modal when the tag picker mode changes, so this redraws without losing the rest of the form. */
  function refreshTagPicker() {
    if (!container) return;
    renderTagsField();
  }

  /** Recomputes suggestions if the smart mode is active; a no-op otherwise (cheaper than checking at every call site). */
  function maybeRefreshSuggestions() {
    if (Settings.get("tagPickerMode") === "smart" && container.querySelector("#tag-suggested-wrap")) {
      renderSuggestedTags();
    }
  }

  // --- Condition field (unchanged by tag-picker mode) ---

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

  async function loadPickers() {
    [allTags, allConditions, allEntries] = await Promise.all([
      DB.getAllTags(),
      DB.getAllConditions(),
      DB.getAllEntries(),
    ]);
    renderTagsField();
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
    selectedTags = new Set();
    selectedConditions = new Set();
    selectedSeverity = null;
    container.querySelector("#note-input").value = "";
    container.querySelector("#timestamp-input").value = DateUtils.nowForInput();
    renderTagsField();
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

  async function init() {
    container = document.getElementById("view-log");
    container.innerHTML = formShellHtml();

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

  return { init, refreshTagPicker };
})();

/**
 * Mode-aware Tags field: either the classic full chip grid, or a searchable
 * field with ranked suggestions (see Settings > "Tag picker style"). Shared
 * by the Log form and Timeline's edit modal so the two can't drift apart.
 *
 * This is a factory (TagPickerField.create), not a singleton like Pickers -
 * Log and Timeline each mount their own independent instance with their own
 * state.
 */
const TagPickerField = (() => {
  /**
   * @param {HTMLElement} container - a wrapper element this owns entirely (innerHTML fully replaced)
   * @param {object} opts
   * @param {Set<string>} opts.selectedTags - mutated in place as tags are picked/removed.
   *   The caller must `.clear()` it to reset selection rather than reassigning
   *   the variable - reassigning would leave this widget still bound to the old Set.
   * @param {() => {name: string}[]} opts.getAllTags
   * @param {() => object[]} opts.getAllEntries - for suggestion ranking (condition co-occurrence + frequency fallback)
   * @param {() => Set<string>|string[]} opts.getSelectedConditions - for the co-occurrence suggestion signal
   * @param {() => string} opts.getNoteText - for the "mentioned in the note" suggestion signal
   * @param {(name: string) => Promise<{name: string}>} opts.createTag - creates/fetches
   *   a tag (e.g. via DB.touchTag) and registers it into the caller's own tag list
   * @param {() => void} [opts.onChange] - called after any selection change
   * @returns {{render: () => void, refreshSuggestions: () => void}}
   */
  function create(container, opts) {
    function notifyChange() {
      if (opts.onChange) opts.onChange();
    }

    // ---- Classic mode: full alphabetical chip grid ----

    function classicHtml() {
      return `
        <div class="tag-field-chips chip-row"></div>
        <div class="add-row">
          <input type="text" class="tag-field-new-input" placeholder="Add tag…" autocomplete="off" />
          <button type="button" class="tag-field-add-btn">Add</button>
        </div>
      `;
    }

    function renderClassicChips() {
      Pickers.renderTagChips(container.querySelector(".tag-field-chips"), opts.getAllTags(), opts.selectedTags, (name) => {
        if (opts.selectedTags.has(name)) {
          opts.selectedTags.delete(name);
        } else {
          opts.selectedTags.add(name);
        }
        notifyChange();
      });
    }

    async function handleAddTag() {
      const input = container.querySelector(".tag-field-new-input");
      const name = input.value.trim();
      if (!name) return;
      const tag = await opts.createTag(name);
      opts.selectedTags.add(tag.name);
      input.value = "";
      renderClassicChips();
      notifyChange();
    }

    function wireClassic() {
      renderClassicChips();
      container.querySelector(".tag-field-add-btn").addEventListener("click", handleAddTag);
      container.querySelector(".tag-field-new-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleAddTag();
        }
      });
    }

    // ---- Smart mode: search + ranked suggestions ----

    function smartHtml() {
      return `
        <div class="tag-field-selected chip-row"></div>
        <div class="tag-suggested-wrap" hidden>
          <span class="tag-suggested-label">Suggested</span>
          <div class="tag-field-suggested chip-row"></div>
        </div>
        <div class="tag-search-wrap">
          <input type="text" class="tag-field-search-input" placeholder="Search or add a tag…" autocomplete="off" />
          <div class="tag-search-results" hidden></div>
        </div>
      `;
    }

    function renderSelectedChips() {
      const wrap = container.querySelector(".tag-field-selected");
      wrap.innerHTML = "";
      Array.from(opts.selectedTags)
        .sort((a, b) => a.localeCompare(b))
        .forEach((name) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chip";
          chip.setAttribute("aria-pressed", "true");
          chip.textContent = name;
          chip.addEventListener("click", () => {
            opts.selectedTags.delete(name);
            refreshSmart();
            notifyChange();
          });
          wrap.appendChild(chip);
        });
    }

    /**
     * Ranks tags by: (1) appearing in the note text, (2) how often they've
     * co-occurred with the currently-selected condition(s) historically, or
     * (3) overall usage frequency as a fallback when neither signal exists.
     * Pure/local heuristic - no AI or network call.
     */
    function computeSuggestedNames() {
      const noteText = (opts.getNoteText() || "").toLowerCase();
      const conditionNames = Array.from(opts.getSelectedConditions() || []);
      const allTags = opts.getAllTags();
      const allEntries = opts.getAllEntries();
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
        .filter((name) => !opts.selectedTags.has(name))
        .slice(0, 8);
    }

    function renderSuggested() {
      const wrap = container.querySelector(".tag-suggested-wrap");
      const chipsWrap = container.querySelector(".tag-field-suggested");
      const names = computeSuggestedNames();

      if (names.length === 0) {
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;

      const allTags = opts.getAllTags();
      const items = names.map((name) => allTags.find((t) => t.name === name)).filter(Boolean);
      Pickers.renderTagChips(
        chipsWrap,
        items,
        opts.selectedTags,
        (name) => {
          opts.selectedTags.add(name); // suggestions only ever show unselected tags, so a tap always adds
          refreshSmart();
          notifyChange();
        },
        { sort: false }
      );
    }

    function renderSearchResults(query) {
      const resultsEl = container.querySelector(".tag-search-results");
      const q = query.trim().toLowerCase();
      const allTags = opts.getAllTags();

      const matches = allTags
        .filter((t) => !opts.selectedTags.has(t.name))
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
          opts.selectedTags.add(t.name);
          clearSearchInput();
          refreshSmart();
          notifyChange();
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
          const tag = await opts.createTag(query.trim());
          opts.selectedTags.add(tag.name);
          clearSearchInput();
          refreshSmart();
          notifyChange();
        });
        resultsEl.appendChild(createRow);
      }

      resultsEl.hidden = false;
    }

    function clearSearchInput() {
      const input = container.querySelector(".tag-field-search-input");
      if (input) input.value = "";
    }

    function refreshSmart() {
      renderSelectedChips();
      renderSuggested();
      renderSearchResults(container.querySelector(".tag-field-search-input").value);
    }

    function wireSmart() {
      renderSelectedChips();
      renderSuggested();

      const searchInput = container.querySelector(".tag-field-search-input");
      const resultsEl = container.querySelector(".tag-search-results");

      searchInput.addEventListener("focus", () => renderSearchResults(searchInput.value));
      searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));
      searchInput.addEventListener("blur", () => {
        resultsEl.hidden = true;
      });
      searchInput.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const q = searchInput.value.trim();
        if (!q) return;
        const existing = opts.getAllTags().find((t) => t.name.toLowerCase() === q.toLowerCase());
        if (existing) {
          opts.selectedTags.add(existing.name);
        } else {
          const tag = await opts.createTag(q);
          opts.selectedTags.add(tag.name);
        }
        clearSearchInput();
        refreshSmart();
        notifyChange();
      });
    }

    // ---- Mode dispatch ----

    function render() {
      const mode = Settings.get("tagPickerMode");
      container.innerHTML = mode === "smart" ? smartHtml() : classicHtml();
      if (mode === "smart") {
        wireSmart();
      } else {
        wireClassic();
      }
    }

    /** Recomputes suggestions if smart mode is active; a cheap no-op otherwise. */
    function refreshSuggestions() {
      if (Settings.get("tagPickerMode") === "smart" && container.querySelector(".tag-suggested-wrap")) {
        renderSuggested();
      }
    }

    render();
    return { render, refreshSuggestions };
  }

  return { create };
})();

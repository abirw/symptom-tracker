/**
 * Shared chip-picker rendering, used anywhere tags/conditions/severity are
 * picked or filtered by (the Log form, Timeline's edit modal and filter bar,
 * the Import candidate editor, and Trends' filters). Each render* function
 * fully replaces its wrapper's children on every call, so callers just
 * re-invoke it after state changes rather than diffing manually.
 */
const Pickers = (() => {
  /**
   * Multi-select toggle chips, shared by tags and conditions (an entry can
   * have any number of both). `selectedSet` is mutated by the caller inside
   * `onToggle`, and the just-clicked chip's own aria-pressed is flipped
   * immediately - no full re-render needed.
   * @param {HTMLElement} wrap - container to fill with chip buttons
   * @param {{name: string}[]} items
   * @param {Set<string>} selectedSet - mutated by `onToggle`, read back after
   * @param {(name: string) => void} onToggle
   */
  function renderMultiSelectChips(wrap, items, selectedSet, onToggle) {
    wrap.innerHTML = "";
    items
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip";
        btn.textContent = item.name;
        btn.setAttribute("aria-pressed", selectedSet.has(item.name) ? "true" : "false");
        btn.addEventListener("click", () => {
          onToggle(item.name);
          btn.setAttribute("aria-pressed", selectedSet.has(item.name) ? "true" : "false");
        });
        wrap.appendChild(btn);
      });
  }

  /** @param {{name: string}[]} tags */
  function renderTagChips(wrap, tags, selectedSet, onToggle) {
    renderMultiSelectChips(wrap, tags, selectedSet, onToggle);
  }

  /** @param {{name: string}[]} conditions */
  function renderConditionChips(wrap, conditions, selectedSet, onToggle) {
    renderMultiSelectChips(wrap, conditions, selectedSet, onToggle);
  }

  /**
   * Renders the fixed 1-5 severity chip row. `data-severity` is set on each
   * chip so CSS can color-code the selected level (green -> red). Unlike
   * tags/conditions, severity is single-select (one value or none), so the
   * whole row is rebuilt after every click via `getSelected`.
   * @param {HTMLElement} wrap
   * @param {() => number|null} getSelected
   * @param {(value: number) => void} onSelect
   */
  function renderSeverity(wrap, getSelected, onSelect) {
    wrap.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip severity-chip";
      btn.dataset.severity = String(i);
      btn.textContent = String(i);
      btn.setAttribute("aria-pressed", getSelected() === i ? "true" : "false");
      btn.addEventListener("click", () => {
        onSelect(i);
        renderSeverity(wrap, getSelected, onSelect);
      });
      wrap.appendChild(btn);
    }
  }

  return { renderTagChips, renderConditionChips, renderSeverity };
})();

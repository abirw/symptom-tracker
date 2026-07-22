/**
 * Shared chip-picker rendering, used by the Log form and the Timeline edit
 * modal (the only two places tags/conditions/severity are picked). Each
 * render* function fully replaces its wrapper's children on every call, so
 * callers just re-invoke it after state changes rather than diffing manually.
 */
const Pickers = (() => {
  /**
   * Renders one toggle chip per tag. Multi-select: `selectedSet` is mutated
   * by the caller inside `onToggle`, and the just-clicked chip's own
   * aria-pressed is flipped immediately (no full re-render needed).
   * @param {HTMLElement} wrap - container to fill with chip buttons
   * @param {{name: string}[]} tags
   * @param {Set<string>} selectedSet - mutated by `onToggle`, read back after
   * @param {(name: string) => void} onToggle
   */
  function renderTagChips(wrap, tags, selectedSet, onToggle) {
    wrap.innerHTML = "";
    tags
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((tag) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip";
        btn.textContent = tag.name;
        btn.setAttribute("aria-pressed", selectedSet.has(tag.name) ? "true" : "false");
        btn.addEventListener("click", () => {
          onToggle(tag.name);
          btn.setAttribute("aria-pressed", selectedSet.has(tag.name) ? "true" : "false");
        });
        wrap.appendChild(btn);
      });
  }

  /**
   * Renders one toggle chip per condition. Single-select: since only one
   * value can be selected at a time, the whole row is rebuilt after every
   * click (via `getSelected`) rather than only touching the clicked chip.
   * @param {HTMLElement} wrap
   * @param {{name: string}[]} conditions
   * @param {() => string|null} getSelected - reads the caller's current selection
   * @param {(name: string) => void} onSelect - caller updates its own state here
   */
  function renderConditionChips(wrap, conditions, getSelected, onSelect) {
    wrap.innerHTML = "";
    conditions
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((cond) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip";
        btn.textContent = cond.name;
        btn.setAttribute("aria-pressed", getSelected() === cond.name ? "true" : "false");
        btn.addEventListener("click", () => {
          onSelect(cond.name);
          renderConditionChips(wrap, conditions, getSelected, onSelect);
        });
        wrap.appendChild(btn);
      });
  }

  /**
   * Renders the fixed 1-5 severity chip row. `data-severity` is set on each
   * chip so CSS can color-code the selected level (green -> red).
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

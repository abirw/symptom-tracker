/* Shared chip-picker rendering, used by the Log form and the Timeline edit modal. */

const Pickers = (() => {
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

  function renderSeverity(wrap, getSelected, onSelect) {
    wrap.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip severity-chip";
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

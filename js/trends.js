/**
 * Trends view: frequency and severity charts (Chart.js), filterable by
 * symptom (tag) and condition. The one requirement this view has to get
 * right per SPEC.md: a tag's chart must never render before that tag's
 * actual `firstUsed` date, or a long-standing symptom you only recently
 * started logging would look like sudden onset.
 *
 * Selecting 0 or 1 symptom keeps the original single-series view (bar chart
 * for frequency, line for severity). Selecting 2+ symptoms switches to
 * compare mode: both charts become multi-series line charts sharing one
 * x-axis, but each symptom's own line stays null (not drawn) before that
 * symptom's own firstUsed date - so comparing an old symptom against a
 * newly-tracked one never implies the newer one appeared out of nowhere.
 */
const TrendsView = (() => {
  let container;
  let entries = [];
  let tags = [];
  let conditions = [];
  let selectedTagNames = new Set();
  let selectedConditionNames = new Set();
  let selectedRange = "90";
  let freqChart = null;
  let sevChart = null;

  const RANGE_OPTIONS = [
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "365", label: "Last 365 days" },
    { value: "all", label: "All time" },
  ];

  // Cycled through by index for compare-mode series; index 0/1 intentionally
  // match the original single-series frequency (teal) / severity (red) colors.
  const SERIES_COLORS = ["#2fb8a1", "#e0665a", "#e0b84a", "#7aa6e0", "#c07ae0", "#8bbf4f", "#e08a45", "#5ad1c7"];

  function render() {
    container.innerHTML = `
      <div class="field">
        <label>Symptoms</label>
        <div id="trends-tag-chips" class="chip-row"></div>
      </div>
      <div class="field">
        <label>Condition</label>
        <div id="trends-condition-chips" class="chip-row"></div>
      </div>
      <div class="filter-bar">
        <select id="trends-range">
          ${RANGE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}
        </select>
      </div>
      <div id="trends-tracking-note" class="tracking-note" hidden></div>
      <p id="trends-empty" class="placeholder" hidden></p>
      <div class="chart-card">
        <h3>Frequency</h3>
        <div class="chart-wrap"><canvas id="freq-chart"></canvas></div>
      </div>
      <div class="chart-card">
        <h3>Severity</h3>
        <div class="chart-wrap"><canvas id="sev-chart"></canvas></div>
      </div>
    `;
  }

  /** Renders the tag/condition filter chips, dropping any prior selection that no longer exists. */
  function populateFilterChips() {
    const tagNames = new Set(tags.map((t) => t.name));
    selectedTagNames.forEach((name) => {
      if (!tagNames.has(name)) selectedTagNames.delete(name);
    });
    const conditionNames = new Set(conditions.map((c) => c.name));
    selectedConditionNames.forEach((name) => {
      if (!conditionNames.has(name)) selectedConditionNames.delete(name);
    });

    Pickers.renderTagChips(container.querySelector("#trends-tag-chips"), tags, selectedTagNames, (name) => {
      if (selectedTagNames.has(name)) {
        selectedTagNames.delete(name);
      } else {
        selectedTagNames.add(name);
      }
      renderCharts();
    });
    Pickers.renderConditionChips(container.querySelector("#trends-condition-chips"), conditions, selectedConditionNames, (name) => {
      if (selectedConditionNames.has(name)) {
        selectedConditionNames.delete(name);
      } else {
        selectedConditionNames.add(name);
      }
      renderCharts();
    });
  }

  // --- Bucketing helpers ---

  /** Monday-anchored start-of-week for `date` (used to group entries into weekly buckets). */
  function bucketKeyWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const dayIndex = (d.getDay() + 6) % 7; // 0 = Monday
    d.setDate(d.getDate() - dayIndex);
    return d;
  }

  /** Start-of-month for `date` (used to group entries into monthly buckets). */
  function bucketKeyMonth(date) {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  /** Short windows get weekly bars/points; longer ones switch to monthly so the chart stays readable. */
  function chooseGranularity(start, end) {
    const spanDays = (end - start) / 86400000;
    return spanDays <= 70 ? "week" : "month";
  }

  /** Generates every bucket start date from `start` to `end`, inclusive, at the given granularity. */
  function buildBuckets(start, end, granularity) {
    const buckets = [];
    const cur = granularity === "week" ? bucketKeyWeek(start) : bucketKeyMonth(start);
    const endKey = granularity === "week" ? bucketKeyWeek(end) : bucketKeyMonth(end);
    while (cur.getTime() <= endKey.getTime()) {
      buckets.push(new Date(cur));
      if (granularity === "week") {
        cur.setDate(cur.getDate() + 7);
      } else {
        cur.setMonth(cur.getMonth() + 1);
      }
    }
    return buckets;
  }

  function formatDate(d) {
    return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function formatBucketLabel(date, granularity) {
    return granularity === "week"
      ? `Wk of ${new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : new Date(date).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  // --- Data window ---

  /** Entries matching the condition filter (if any); the tag/date filtering happens per-series on top of this. */
  function conditionFilteredPool() {
    if (selectedConditionNames.size === 0) return entries;
    return entries.filter((e) => (e.conditions || []).some((c) => selectedConditionNames.has(c)));
  }

  /**
   * Resolves the effective [start, end] window for one symptom (or `null`
   * for "all symptoms"). The critical rule lives here: when a specific tag
   * is given, `start` is clamped to that tag's firstUsed date no matter how
   * far back the range filter would otherwise reach.
   * @param {string|null} tagName
   * @returns {{start: Date, end: Date, tagFirstUsed: Date|null}}
   */
  function computeWindow(tagName) {
    const now = new Date();
    let rangeStart = null;
    if (selectedRange !== "all") {
      rangeStart = new Date(now);
      rangeStart.setDate(rangeStart.getDate() - Number(selectedRange));
    }

    let tagFirstUsed = null;
    if (tagName) {
      const tag = tags.find((t) => t.name === tagName);
      tagFirstUsed = tag ? new Date(tag.firstUsed) : null;
    }

    let start;
    if (tagFirstUsed) {
      // Never show a tag's chart before it actually started being tracked -
      // otherwise a long-standing symptom looks like it appeared out of nowhere.
      start = rangeStart && rangeStart > tagFirstUsed ? rangeStart : tagFirstUsed;
    } else if (rangeStart) {
      start = rangeStart;
    } else {
      // "All symptoms" + "all time": fall back to the earliest matching entry ever logged.
      const pool = conditionFilteredPool();
      start =
        pool.reduce((min, e) => {
          const t = new Date(e.timestamp);
          return !min || t < min ? t : min;
        }, null) || now;
    }

    return { start, end: now, tagFirstUsed };
  }

  function destroyCharts() {
    if (freqChart) {
      freqChart.destroy();
      freqChart = null;
    }
    if (sevChart) {
      sevChart.destroy();
      sevChart = null;
    }
  }

  function chartOptions({ beginAtZero, max, stepSize }, showLegend) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: "#9fb0ac" }, grid: { color: "#223330" } },
        y: {
          beginAtZero,
          max,
          ticks: { color: "#9fb0ac", stepSize },
          grid: { color: "#223330" },
        },
      },
      plugins: {
        legend: { display: showLegend, labels: { color: "#9fb0ac", boxWidth: 12, font: { size: 11 } } },
      },
    };
  }

  /** 0 or 1 symptom selected: the original single-series view (bar + line). */
  function renderSingleMode(pool, tagName, noteEl, emptyEl) {
    const { start, end, tagFirstUsed } = computeWindow(tagName);

    noteEl.innerHTML = "";
    if (tagFirstUsed) {
      noteEl.hidden = false;
      noteEl.textContent = `Tracking started ${formatDate(
        tagFirstUsed
      )} — no data is shown before this date because it wasn't being logged yet.`;
    } else {
      noteEl.hidden = true;
    }

    const filtered = pool.filter((e) => {
      const t = new Date(e.timestamp);
      if (t < start || t > end) return false;
      if (tagName && !(e.tags || []).includes(tagName)) return false;
      return true;
    });

    emptyEl.hidden = filtered.length !== 0;
    if (filtered.length === 0) emptyEl.textContent = "No entries in this range.";

    const granularity = chooseGranularity(start, end);
    const buckets = buildBuckets(start, end, granularity);
    const labels = buckets.map((b) => formatBucketLabel(b, granularity));

    const freqCounts = buckets.map(() => 0);
    const sevSums = buckets.map(() => 0);
    const sevCounts = buckets.map(() => 0);

    filtered.forEach((e) => {
      const t = new Date(e.timestamp);
      const key = granularity === "week" ? bucketKeyWeek(t) : bucketKeyMonth(t);
      const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
      if (idx === -1) return;
      freqCounts[idx]++;
      if (e.severity != null) {
        sevSums[idx] += e.severity;
        sevCounts[idx]++;
      }
    });

    // Buckets with no severity data stay `null` (a gap in the line) rather than a misleading 0.
    const sevAverages = buckets.map((_, i) => (sevCounts[i] ? +(sevSums[i] / sevCounts[i]).toFixed(2) : null));

    freqChart = new Chart(container.querySelector("#freq-chart").getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: tagName || "All symptoms",
            data: freqCounts,
            backgroundColor: SERIES_COLORS[0],
            borderRadius: 4,
          },
        ],
      },
      options: chartOptions({ beginAtZero: true, stepSize: 1 }, false),
    });

    sevChart = new Chart(container.querySelector("#sev-chart").getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Avg severity",
            data: sevAverages,
            borderColor: SERIES_COLORS[1],
            backgroundColor: SERIES_COLORS[1],
            spanGaps: false,
            tension: 0.25,
            pointRadius: 3,
          },
        ],
      },
      options: chartOptions({ beginAtZero: true, max: 5, stepSize: 1 }, false),
    });
  }

  /** 2+ symptoms selected: one line per symptom, sharing an x-axis but each independently clipped to its own firstUsed. */
  function renderCompareMode(pool, tagNames, noteEl, emptyEl) {
    const now = new Date();
    const windows = tagNames.map((name) => ({ name, ...computeWindow(name) }));
    const sharedStart = windows.reduce((min, w) => (!min || w.start < min ? w.start : min), null);

    noteEl.hidden = false;
    noteEl.innerHTML = "";
    const intro = document.createElement("span");
    intro.textContent = "Tracking started — ";
    noteEl.appendChild(intro);
    windows.forEach((w, i) => {
      if (i > 0) noteEl.appendChild(document.createTextNode(" · "));
      const span = document.createElement("span");
      span.textContent = `${w.name}: ${formatDate(w.tagFirstUsed || w.start)}`;
      noteEl.appendChild(span);
    });

    const granularity = chooseGranularity(sharedStart, now);
    const buckets = buildBuckets(sharedStart, now, granularity);
    const labels = buckets.map((b) => formatBucketLabel(b, granularity));

    let anyData = false;

    const perTag = windows.map((w, i) => {
      const filtered = pool.filter((e) => {
        const t = new Date(e.timestamp);
        return t >= w.start && t <= now && (e.tags || []).includes(w.name);
      });
      if (filtered.length > 0) anyData = true;

      const counts = buckets.map(() => 0);
      const sums = buckets.map(() => 0);
      const sevCounts = buckets.map(() => 0);
      filtered.forEach((e) => {
        const t = new Date(e.timestamp);
        const key = granularity === "week" ? bucketKeyWeek(t) : bucketKeyMonth(t);
        const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
        if (idx === -1) return;
        counts[idx]++;
        if (e.severity != null) {
          sums[idx] += e.severity;
          sevCounts[idx]++;
        }
      });

      // Null out any bucket before the one containing this symptom's own
      // window start, so its line simply doesn't appear yet rather than
      // showing a false flat zero. Compared as bucket keys, not raw
      // instants - w.start almost never falls exactly on a bucket boundary,
      // so comparing it directly against each bucket's start would wrongly
      // null out the whole bucket it actually starts in, discarding real
      // entries logged later that same week/month.
      const wStartKey = granularity === "week" ? bucketKeyWeek(w.start) : bucketKeyMonth(w.start);
      const freqData = buckets.map((b, idx) => (b.getTime() < wStartKey.getTime() ? null : counts[idx]));
      const sevData = buckets.map((b, idx) => {
        if (b.getTime() < wStartKey.getTime()) return null;
        return sevCounts[idx] ? +(sums[idx] / sevCounts[idx]).toFixed(2) : null;
      });

      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      const shared = { borderColor: color, backgroundColor: color, spanGaps: false, tension: 0.25, pointRadius: 2 };
      return {
        freqDataset: { label: w.name, data: freqData, ...shared },
        sevDataset: { label: w.name, data: sevData, ...shared },
      };
    });

    emptyEl.hidden = anyData;
    if (!anyData) emptyEl.textContent = "No entries in this range.";

    freqChart = new Chart(container.querySelector("#freq-chart").getContext("2d"), {
      type: "line",
      data: { labels, datasets: perTag.map((t) => t.freqDataset) },
      options: chartOptions({ beginAtZero: true, stepSize: 1 }, true),
    });

    sevChart = new Chart(container.querySelector("#sev-chart").getContext("2d"), {
      type: "line",
      data: { labels, datasets: perTag.map((t) => t.sevDataset) },
      options: chartOptions({ beginAtZero: true, max: 5, stepSize: 1 }, true),
    });
  }

  /** Recomputes the effective window(s)/buckets and (re)draws both charts from scratch. */
  function renderCharts() {
    const noteEl = container.querySelector("#trends-tracking-note");
    const emptyEl = container.querySelector("#trends-empty");
    const freqCard = container.querySelector("#freq-chart").closest(".chart-card");
    const sevCard = container.querySelector("#sev-chart").closest(".chart-card");

    // Chart.js throws if you construct a new Chart on a canvas that already has one attached.
    destroyCharts();

    if (entries.length === 0) {
      noteEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = "No entries yet — log a few to see trends.";
      freqCard.hidden = true;
      sevCard.hidden = true;
      return;
    }

    freqCard.hidden = false;
    sevCard.hidden = false;

    const pool = conditionFilteredPool();
    const selected = Array.from(selectedTagNames);

    if (selected.length >= 2) {
      renderCompareMode(pool, selected, noteEl, emptyEl);
    } else {
      renderSingleMode(pool, selected[0] || null, noteEl, emptyEl);
    }
  }

  async function loadData() {
    [entries, tags, conditions] = await Promise.all([DB.getAllEntries(), DB.getAllTags(), DB.getAllConditions()]);
    populateFilterChips();
    renderCharts();
  }

  async function init() {
    container = document.getElementById("view-trends");
    render();

    container.querySelector("#trends-range").value = selectedRange;
    container.querySelector("#trends-range").addEventListener("change", (e) => {
      selectedRange = e.target.value;
      renderCharts();
    });

    await loadData();
  }

  return { init, onShow: loadData };
})();

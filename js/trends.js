/**
 * Trends view: per-tag frequency and severity charts (Chart.js). The one
 * requirement this view has to get right per SPEC.md: a tag's chart must
 * never render before that tag's actual `firstUsed` date, or a long-standing
 * symptom you only recently started logging would look like sudden onset.
 */
const TrendsView = (() => {
  let container;
  let entries = [];
  let tags = [];
  let selectedTag = "all";
  let selectedRange = "90";
  let freqChart = null;
  let sevChart = null;

  const RANGE_OPTIONS = [
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "365", label: "Last 365 days" },
    { value: "all", label: "All time" },
  ];

  function render() {
    container.innerHTML = `
      <div class="filter-bar">
        <select id="trends-tag"></select>
        <select id="trends-range">
          ${RANGE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}
        </select>
      </div>
      <p id="trends-tracking-note" class="tracking-note" hidden></p>
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

  function populateTagSelect() {
    const select = container.querySelector("#trends-tag");
    select.innerHTML = "";

    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All tags";
    select.appendChild(allOpt);

    tags
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.name;
        opt.textContent = t.name;
        select.appendChild(opt);
      });

    if (selectedTag !== "all" && !tags.some((t) => t.name === selectedTag)) {
      selectedTag = "all"; // the previously-selected tag was deleted/renamed elsewhere
    }
    select.value = selectedTag;
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

  /**
   * Resolves the actual [start, end] window to chart, given the selected tag
   * and date-range filter. The critical rule lives here: when a specific tag
   * is selected, `start` is clamped to that tag's firstUsed date no matter
   * how far back the range filter would otherwise reach.
   * @returns {{start: Date, end: Date, tagFirstUsed: Date|null}}
   */
  function getEffectiveWindow() {
    const now = new Date();
    let rangeStart = null;
    if (selectedRange !== "all") {
      rangeStart = new Date(now);
      rangeStart.setDate(rangeStart.getDate() - Number(selectedRange));
    }

    let tagFirstUsed = null;
    if (selectedTag !== "all") {
      const tag = tags.find((t) => t.name === selectedTag);
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
      // "All tags" + "all time": fall back to the earliest entry ever logged.
      start =
        entries.reduce((min, e) => {
          const t = new Date(e.timestamp);
          return !min || t < min ? t : min;
        }, null) || now;
    }

    return { start, end: now, tagFirstUsed };
  }

  function relevantEntries(start, end) {
    return entries.filter((e) => {
      const t = new Date(e.timestamp);
      if (t < start || t > end) return false;
      if (selectedTag !== "all" && !(e.tags || []).includes(selectedTag)) return false;
      return true;
    });
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

  function chartOptions({ beginAtZero, max, stepSize }) {
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
        legend: { display: false },
      },
    };
  }

  /** Recomputes the effective window/buckets and (re)draws both charts from scratch. */
  function renderCharts() {
    const { start, end, tagFirstUsed } = getEffectiveWindow();

    const noteEl = container.querySelector("#trends-tracking-note");
    const emptyEl = container.querySelector("#trends-empty");
    const freqCard = container.querySelector("#freq-chart").closest(".chart-card");
    const sevCard = container.querySelector("#sev-chart").closest(".chart-card");

    if (tagFirstUsed) {
      noteEl.hidden = false;
      noteEl.textContent = `Tracking started ${formatDate(
        tagFirstUsed
      )} — no data is shown before this date because it wasn't being logged yet.`;
    } else {
      noteEl.hidden = true;
    }

    // Chart.js throws if you construct a new Chart on a canvas that already has one attached.
    destroyCharts();

    if (entries.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = "No entries yet — log a few to see trends.";
      freqCard.hidden = true;
      sevCard.hidden = true;
      return;
    }

    freqCard.hidden = false;
    sevCard.hidden = false;

    const filtered = relevantEntries(start, end);
    emptyEl.hidden = filtered.length !== 0;
    if (filtered.length === 0) {
      emptyEl.textContent = "No entries in this range.";
    }

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
            label: selectedTag === "all" ? "All tags" : selectedTag,
            data: freqCounts,
            backgroundColor: "#2fb8a1",
            borderRadius: 4,
          },
        ],
      },
      options: chartOptions({ beginAtZero: true, stepSize: 1 }),
    });

    sevChart = new Chart(container.querySelector("#sev-chart").getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Avg severity",
            data: sevAverages,
            borderColor: "#e0665a",
            backgroundColor: "#e0665a",
            spanGaps: false,
            tension: 0.25,
            pointRadius: 3,
          },
        ],
      },
      options: chartOptions({ beginAtZero: true, max: 5, stepSize: 1 }),
    });
  }

  async function loadData() {
    [entries, tags] = await Promise.all([DB.getAllEntries(), DB.getAllTags()]);
    populateTagSelect();
    renderCharts();
  }

  async function init() {
    container = document.getElementById("view-trends");
    render();

    container.querySelector("#trends-range").value = selectedRange;

    container.querySelector("#trends-tag").addEventListener("change", (e) => {
      selectedTag = e.target.value;
      renderCharts();
    });
    container.querySelector("#trends-range").addEventListener("change", (e) => {
      selectedRange = e.target.value;
      renderCharts();
    });

    await loadData();
  }

  return { init, onShow: loadData };
})();

/**
 * Reports view: a focused, printable report for one symptom (or an "Overview"
 * across everything when none is selected). Reuses the same firstUsed-clamping
 * rule as Trends (a tag's charts never render before it was actually being
 * tracked) and the same condition/date-range filter pattern.
 *
 * Every section - stat cards, charts, streaks, clusters, co-occurrence, notes -
 * is computed from the SAME filtered pool (condition filter + date range),
 * so "Last 90 days" scopes the whole report, including episode detection.
 */
const ReportsView = (() => {
  let container;
  let entries = [];
  let tags = [];
  let conditions = [];
  let selectedTagName = new Set(); // at most 1 entry - single-select via clear-then-add
  let selectedConditionNames = new Set();
  let selectedRange = "90";
  let maxGapDays = 1;
  let activeCharts = [];
  let wordTrendState = { word: null }; // which note-word's mini trend chart is expanded

  const RANGE_OPTIONS = [
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "365", label: "Last 365 days" },
    { value: "all", label: "All time" },
  ];

  // Matches --sev-1..--sev-5 in style.css (mild green -> severe red).
  const SEV_COLORS = ["#3aa66b", "#8bbf4f", "#e0b84a", "#e08a45", "#e0665a"];
  const SERIES_COLOR = "#2fb8a1";

  function render() {
    container.innerHTML = `
      <div class="field">
        <label>Symptom</label>
        <div id="reports-tag-chips" class="chip-row"></div>
      </div>
      <div class="field">
        <label>Condition</label>
        <div id="reports-condition-chips" class="chip-row"></div>
      </div>
      <div class="filter-bar">
        <select id="reports-range">
          ${RANGE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}
        </select>
      </div>
      <div id="reports-tracking-note" class="tracking-note" hidden></div>
      <p id="reports-empty" class="placeholder" hidden></p>
      <div id="reports-body"></div>
      <button type="button" id="reports-print-btn" class="secondary-btn no-print">Share PDF Report</button>
    `;
  }

  function populateFilterChips() {
    const tagNames = new Set(tags.map((t) => t.name));
    selectedTagName.forEach((name) => {
      if (!tagNames.has(name)) selectedTagName.delete(name);
    });
    const conditionNames = new Set(conditions.map((c) => c.name));
    selectedConditionNames.forEach((name) => {
      if (!conditionNames.has(name)) selectedConditionNames.delete(name);
    });

    Pickers.renderTagChips(container.querySelector("#reports-tag-chips"), tags, selectedTagName, (name) => {
      if (selectedTagName.has(name)) {
        selectedTagName.clear(); // toggling the only-selected tag off -> back to Overview
      } else {
        selectedTagName.clear();
        selectedTagName.add(name);
      }
      wordTrendState.word = null;
      renderReport();
    });
    Pickers.renderConditionChips(container.querySelector("#reports-condition-chips"), conditions, selectedConditionNames, (name) => {
      if (selectedConditionNames.has(name)) {
        selectedConditionNames.delete(name);
      } else {
        selectedConditionNames.add(name);
      }
      renderReport();
    });
  }

  function conditionFilteredPool() {
    if (selectedConditionNames.size === 0) return entries;
    return entries.filter((e) => (e.conditions || []).some((c) => selectedConditionNames.has(c)));
  }

  /** Same firstUsed-clamping rule as Trends: never show a tag's data before it started being tracked. */
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
      start = rangeStart && rangeStart > tagFirstUsed ? rangeStart : tagFirstUsed;
    } else if (rangeStart) {
      start = rangeStart;
    } else {
      const pool = conditionFilteredPool();
      start =
        pool.reduce((min, e) => {
          const t = new Date(e.timestamp);
          return !min || t < min ? t : min;
        }, null) || now;
    }

    return { start, end: now, tagFirstUsed };
  }

  function filterByTag(pool, tagName) {
    if (!tagName) return pool;
    return pool.filter((e) => (e.tags || []).includes(tagName));
  }

  function destroyCharts() {
    activeCharts.forEach((c) => c.destroy());
    activeCharts = [];
  }

  function chartOptions({ beginAtZero, max, stepSize } = {}, showLegend = false, printMode = false) {
    const tickColor = printMode ? "#333333" : "#9fb0ac";
    const gridColor = printMode ? "#dddddd" : "#223330";
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: tickColor }, grid: { color: gridColor } },
        y: { beginAtZero, max, ticks: { color: tickColor, stepSize }, grid: { color: gridColor } },
      },
      plugins: {
        legend: { display: showLegend, labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } },
      },
    };
  }

  function makeChart(canvas, config) {
    const chart = new Chart(canvas.getContext("2d"), config);
    activeCharts.push(chart);
    return chart;
  }

  function statCard(label, value) {
    return `<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
  }

  function formatDays(n) {
    if (n == null) return "—";
    return `${n} ${n === 1 ? "day" : "days"}`;
  }

  // --- Section builders ---

  function buildStatCardsHtml(focusEntries, streaks) {
    const withSeverity = focusEntries.filter((e) => e.severity != null);
    const avgSeverity = withSeverity.length
      ? (withSeverity.reduce((s, e) => s + e.severity, 0) / withSeverity.length).toFixed(1)
      : "—";
    return `
      <div class="stat-grid">
        ${statCard("Total Entries", focusEntries.length)}
        ${statCard("Avg Severity", avgSeverity)}
        ${statCard("Days Since Last", formatDays(streaks.daysSinceLast))}
        ${statCard("Longest Symptom-Free Streak", formatDays(streaks.longestGapDays))}
      </div>
    `;
  }

  function renderFrequencySeverityCharts(bodyEl, focusEntries, tagName, start, end, printMode) {
    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="chart-card"><h3>Frequency</h3><div class="chart-wrap"><canvas id="report-freq-chart"></canvas></div></div>
       <div class="chart-card"><h3>Severity Over Time</h3><div class="chart-wrap"><canvas id="report-sev-chart"></canvas></div></div>`
    );

    const granularity = Bucketing.chooseGranularity(start, end);
    const buckets = Bucketing.buildBuckets(start, end, granularity);
    const labels = buckets.map((b) => Bucketing.formatBucketLabel(b, granularity));

    const freqCounts = buckets.map(() => 0);
    const sevSums = buckets.map(() => 0);
    const sevCounts = buckets.map(() => 0);

    focusEntries.forEach((e) => {
      const t = new Date(e.timestamp);
      const key = granularity === "week" ? Bucketing.bucketKeyWeek(t) : Bucketing.bucketKeyMonth(t);
      const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
      if (idx === -1) return;
      freqCounts[idx]++;
      if (e.severity != null) {
        sevSums[idx] += e.severity;
        sevCounts[idx]++;
      }
    });
    const sevAverages = buckets.map((_, i) => (sevCounts[i] ? +(sevSums[i] / sevCounts[i]).toFixed(2) : null));

    makeChart(bodyEl.querySelector("#report-freq-chart"), {
      type: "bar",
      data: { labels, datasets: [{ label: tagName || "All symptoms", data: freqCounts, backgroundColor: SERIES_COLOR, borderRadius: 4 }] },
      options: chartOptions({ beginAtZero: true, stepSize: 1 }, false, printMode),
    });
    makeChart(bodyEl.querySelector("#report-sev-chart"), {
      type: "line",
      data: {
        labels,
        datasets: [{ label: "Avg severity", data: sevAverages, borderColor: SERIES_COLOR, backgroundColor: SERIES_COLOR, spanGaps: false, tension: 0.25, pointRadius: 3 }],
      },
      options: chartOptions({ beginAtZero: true, max: 5, stepSize: 1 }, false, printMode),
    });
  }

  function renderSeverityDistribution(bodyEl, focusEntries, printMode) {
    const dist = Analysis.computeSeverityDistribution(focusEntries);
    if (!dist.some((d) => d.count > 0)) return;
    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="chart-card"><h3>Severity Distribution</h3><div class="chart-wrap"><canvas id="report-sevdist-chart"></canvas></div></div>`
    );
    makeChart(bodyEl.querySelector("#report-sevdist-chart"), {
      type: "bar",
      data: {
        labels: dist.map((d) => `Severity ${d.severity}`),
        datasets: [{ data: dist.map((d) => d.count), backgroundColor: SEV_COLORS, borderRadius: 4 }],
      },
      options: chartOptions({ beginAtZero: true, stepSize: 1 }, false, printMode),
    });
  }

  function renderDayOfWeek(bodyEl, focusEntries, printMode) {
    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="chart-card"><h3>Day of Week</h3><div class="chart-wrap"><canvas id="report-dow-chart"></canvas></div></div>`
    );
    const dow = Analysis.computeDayOfWeekDistribution(focusEntries);
    makeChart(bodyEl.querySelector("#report-dow-chart"), {
      type: "bar",
      data: { labels: dow.map((d) => d.day), datasets: [{ data: dow.map((d) => d.count), backgroundColor: SERIES_COLOR, borderRadius: 4 }] },
      options: chartOptions({ beginAtZero: true, stepSize: 1 }, false, printMode),
    });
  }

  function renderStreaksCard(bodyEl, streaks) {
    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="chart-card">
        <h3>Streaks &amp; Gaps</h3>
        <div class="stat-grid">
          ${statCard("Shortest Gap", formatDays(streaks.shortestGapDays))}
          ${statCard("Average Gap", formatDays(streaks.averageGapDays))}
          ${statCard("Longest Gap", formatDays(streaks.longestGapDays))}
          ${statCard("Occurrence Days", streaks.occurrenceDayCount)}
        </div>
      </div>`
    );
  }

  function renderCoOccurrence(bodyEl, pool, tagName) {
    const co = Analysis.computeCoOccurrence(pool, tagName);
    if (co.tags.length === 0) return;
    const rows = co.tags
      .slice(0, 8)
      .map(
        (item) =>
          `<div class="cooccur-row"><span class="chip chip-static">${item.name}</span><span class="cooccur-pct">${item.percentOfDays}% of days</span></div>`
      )
      .join("");
    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="chart-card">
        <h3>Co-occurring Symptoms</h3>
        <div class="cooccur-list">${rows}</div>
      </div>`
    );
  }

  function renderClusters(bodyEl, pool, tagName) {
    const clusters = Analysis.computeClusters(pool, tagName, { maxGapDays, minClusterDays: 2 });
    const items = clusters
      .map(
        (c) =>
          `<div class="cluster-item">
            <div class="cluster-range">${Bucketing.formatDate(c.startDate)} – ${Bucketing.formatDate(c.endDate)}</div>
            <div class="cluster-meta">${c.dayCount} days · ${c.entryCount} ${c.entryCount === 1 ? "entry" : "entries"}${
            c.avgSeverity != null ? ` · avg severity ${c.avgSeverity}` : ""
          }</div>
          </div>`
      )
      .join("");
    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="chart-card">
        <h3>Clusters / Episodes</h3>
        <div class="field no-print" style="margin-bottom: 0.75rem;">
          <label for="cluster-gap-input">Max gap between days still counted as the same episode</label>
          <input type="number" id="cluster-gap-input" min="0" max="14" value="${maxGapDays}" />
        </div>
        ${clusters.length ? `<div class="cluster-list">${items}</div>` : `<p class="placeholder" style="margin-top:0.5rem;">No recurring clusters detected in this range.</p>`}
      </div>`
    );
    bodyEl.querySelector("#cluster-gap-input").addEventListener("change", (e) => {
      const val = Number(e.target.value);
      maxGapDays = Number.isFinite(val) && val >= 0 ? val : 1;
      renderReport();
    });
  }

  function renderNotesWordFrequency(bodyEl, pool, printMode) {
    const result = Analysis.computeNoteWordFrequency(pool, { topN: 15 });
    if (result.words.length === 0) return;

    const rows = result.words
      .map((w) => {
        const countText = `${w.count} ${w.count === 1 ? "entry" : "entries"}`;
        const meta =
          w.avgSeverityWithWord != null && result.overallAvgSeverity != null
            ? `${countText} · avg severity ${w.avgSeverityWithWord} vs overall ${result.overallAvgSeverity}`
            : countText;
        return `<button type="button" class="word-freq-row" data-word="${w.word}"><span class="word-freq-word">${w.word}</span><span class="word-freq-meta">${meta}</span></button>`;
      })
      .join("");

    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="chart-card">
        <h3>Notes: Common Words</h3>
        <div class="word-freq-list">${rows}</div>
        <div id="word-trend-wrap"></div>
      </div>`
    );

    bodyEl.querySelectorAll(".word-freq-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        wordTrendState.word = wordTrendState.word === btn.dataset.word ? null : btn.dataset.word;
        renderWordTrend(bodyEl.querySelector("#word-trend-wrap"), pool, printMode);
      });
    });
    renderWordTrend(bodyEl.querySelector("#word-trend-wrap"), pool, printMode);
  }

  function renderWordTrend(wrapEl, pool, printMode) {
    wrapEl.innerHTML = "";
    const word = wordTrendState.word;
    if (!word) return;

    const matching = pool.filter((e) => Analysis.tokenize(e.note).includes(word));
    if (matching.length === 0) return;

    const start = matching.reduce((min, e) => {
      const t = new Date(e.timestamp);
      return !min || t < min ? t : min;
    }, null);
    const end = new Date();
    const granularity = Bucketing.chooseGranularity(start, end);
    const buckets = Bucketing.buildBuckets(start, end, granularity);
    const labels = buckets.map((b) => Bucketing.formatBucketLabel(b, granularity));
    const counts = buckets.map(() => 0);
    matching.forEach((e) => {
      const t = new Date(e.timestamp);
      const key = granularity === "week" ? Bucketing.bucketKeyWeek(t) : Bucketing.bucketKeyMonth(t);
      const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
      if (idx !== -1) counts[idx]++;
    });

    wrapEl.innerHTML = `<h4 class="word-trend-title">"${word}" mentions over time</h4><div class="chart-wrap chart-wrap-small"><canvas id="word-trend-chart"></canvas></div>`;
    makeChart(wrapEl.querySelector("#word-trend-chart"), {
      type: "bar",
      data: { labels, datasets: [{ data: counts, backgroundColor: SERIES_COLOR, borderRadius: 4 }] },
      options: chartOptions({ beginAtZero: true, stepSize: 1 }, false, printMode),
    });
  }

  // --- Overview (no symptom selected) ---

  function renderOverview(bodyEl, pool, printMode) {
    const withSeverity = pool.filter((e) => e.severity != null);
    const avgSeverity = withSeverity.length ? (withSeverity.reduce((s, e) => s + e.severity, 0) / withSeverity.length).toFixed(1) : "—";

    const tagCounts = new Map();
    pool.forEach((e) => (e.tags || []).forEach((name) => tagCounts.set(name, (tagCounts.get(name) || 0) + 1)));
    const mostLogged = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    const earliest = pool.reduce((min, e) => {
      const t = new Date(e.timestamp);
      return !min || t < min ? t : min;
    }, null);

    bodyEl.insertAdjacentHTML(
      "beforeend",
      `<div class="stat-grid">
        ${statCard("Total Entries", pool.length)}
        ${statCard("Tracking Span", earliest ? `${Bucketing.formatDate(earliest)} – now` : "—")}
        ${statCard("Most-Logged Symptom", mostLogged ? mostLogged[0] : "—")}
        ${statCard("Avg Severity", avgSeverity)}
      </div>`
    );

    renderNotesWordFrequency(bodyEl, pool, printMode);
  }

  // --- Dispatcher ---

  function renderReport(printMode = false) {
    const noteEl = container.querySelector("#reports-tracking-note");
    const emptyEl = container.querySelector("#reports-empty");
    const bodyEl = container.querySelector("#reports-body");

    destroyCharts();
    bodyEl.innerHTML = "";
    noteEl.hidden = true;
    emptyEl.hidden = true;

    if (entries.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = "No entries yet — log a few to generate a report.";
      return;
    }

    const tagName = [...selectedTagName][0] || null;
    const pool = conditionFilteredPool();
    const { start, end, tagFirstUsed } = computeWindow(tagName);
    const windowedPool = pool.filter((e) => {
      const t = new Date(e.timestamp);
      return t >= start && t <= end;
    });

    if (tagFirstUsed) {
      noteEl.hidden = false;
      noteEl.textContent = `Tracking started ${Bucketing.formatDate(tagFirstUsed)} — no data is shown before this date because it wasn't being logged yet.`;
    }

    if (windowedPool.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = "No entries in this range.";
      return;
    }

    if (!tagName) {
      renderOverview(bodyEl, windowedPool, printMode);
      return;
    }

    const focusEntries = filterByTag(windowedPool, tagName);
    if (focusEntries.length === 0) {
      emptyEl.hidden = false;
      emptyEl.textContent = "No entries in this range.";
      return;
    }

    const streaks = Analysis.computeStreaksAndGaps(windowedPool, tagName, new Date());

    bodyEl.insertAdjacentHTML("beforeend", buildStatCardsHtml(focusEntries, streaks));
    renderFrequencySeverityCharts(bodyEl, focusEntries, tagName, start, end, printMode);
    renderSeverityDistribution(bodyEl, focusEntries, printMode);
    renderDayOfWeek(bodyEl, focusEntries, printMode);
    renderStreaksCard(bodyEl, streaks);
    renderCoOccurrence(bodyEl, windowedPool, tagName);
    renderClusters(bodyEl, windowedPool, tagName);
    renderNotesWordFrequency(bodyEl, focusEntries, printMode);
  }

  // --- Print / PDF export ---

  function handleSharePdf() {
    renderReport(true);
    const restore = () => {
      renderReport(false);
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  async function loadData() {
    [entries, tags, conditions] = await Promise.all([DB.getAllEntries(), DB.getAllTags(), DB.getAllConditions()]);
    populateFilterChips();
    renderReport();
  }

  async function init() {
    container = document.getElementById("view-reports");
    render();

    container.querySelector("#reports-range").value = selectedRange;
    container.querySelector("#reports-range").addEventListener("change", (e) => {
      selectedRange = e.target.value;
      renderReport();
    });
    container.querySelector("#reports-print-btn").addEventListener("click", handleSharePdf);

    await loadData();
  }

  return { init, onShow: loadData };
})();

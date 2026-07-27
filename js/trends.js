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
 *
 * A separate "Factors" filter (period, heatwaves, medication changes, etc.)
 * doesn't filter the symptom data at all - every selected factor is drawn
 * directly on the Frequency chart instead, using its own display type (Data
 * tab's "Manage Factors" list, default "bar"): "bar" factors become an
 * additional bar series on a secondary (right-hand) y-axis, sharing the
 * exact same bucket window as the symptom data so the two are directly
 * comparable; "line" factors (e.g. a medication change) and "span" factors
 * (e.g. a period) are instead drawn as an overlay - on BOTH the Frequency
 * and Severity charts - via a small custom Chart.js plugin, registered once
 * below. Colors for all three factor types are assigned from one shared
 * sequence (computeFactorColors) so a given factor looks the same regardless
 * of which of the three treatments it uses.
 *
 * Imported temperature readings (Data tab's "Import Temperature Data") get
 * similar treatment: an always-on "Temperature" chart-card (bucket-averaged,
 * not summed) that only appears when at least one reading falls in the
 * current window - no filter toggle needed since there's just one series.
 *
 * Chart Detail (Day/Week/Month) is a manual toggle, not auto-chosen - unlike
 * Reports' charts, which still auto-pick week-vs-month via
 * Bucketing.chooseGranularity based on the date range. "Day" only exists as
 * an option here; Bucketing.chooseGranularity deliberately never returns it.
 *
 * Frequency/severity counting is weighted by entry.occurrenceCount (via
 * Analysis.occurrenceCount) - an entry logged as 2 occurrences counts twice
 * in the frequency bar and pulls the severity average twice as hard.
 */
const TrendsView = (() => {
  let container;
  let entries = [];
  let tags = [];
  let conditions = [];
  let factors = [];
  let factorEntries = [];
  let temperatures = [];
  let selectedTagNames = new Set();
  let selectedConditionNames = new Set();
  let selectedFactorNames = new Set();
  let selectedRange = "90";
  let selectedGranularity = "week";
  let freqChart = null;
  let sevChart = null;
  let temperatureChart = null;

  const RANGE_OPTIONS = [
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "365", label: "Last 365 days" },
    { value: "all", label: "All time" },
  ];

  // Cycled through by index for compare-mode series; index 0/1 intentionally
  // match the original single-series frequency (teal) / severity (red) colors.
  const SERIES_COLORS = ["#2fb8a1", "#e0665a", "#e0b84a", "#7aa6e0", "#c07ae0", "#8bbf4f", "#e08a45", "#5ad1c7"];

  /** Reshapes factor entries into the {timestamp, tags} shape Analysis' generic day-based functions (computeClusters) expect - mirrors the same adapter established in js/reports.js. */
  const asTagEntries = (factorEntryList) => factorEntryList.map((fe) => ({ timestamp: fe.timestamp, tags: [fe.name] }));

  /** "#rrggbb" -> "rgba(r, g, b, alpha)", for translucent span fills. */
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * Draws line/span factor markers on top of whichever chart opts in via
   * `options.plugins.factorMarkers` - registered once, globally, so it's
   * completely inert on every other chart in the app (they never set that
   * option). Positions are bucket indices, converted to pixels via the
   * chart's own category x-scale - the same indices the bar/line datasets
   * are already keyed by.
   */
  const FACTOR_MARKERS_PLUGIN = {
    id: "factorMarkers",
    afterDraw(chart) {
      // Chart.js registers a plugin globally across EVERY chart in the app,
      // not just the ones that opt in - and its options-resolution proxy
      // returns a truthy (but empty) object for `plugins.factorMarkers` even
      // on a chart that never sets it, so `cfg` itself is never a reliable
      // "did this chart opt in" check. Falling back to `[]` for `lines`/
      // `spans` individually is what actually makes this a no-op everywhere
      // else, instead of throwing on every other chart in the app (Reports'
      // charts included).
      const cfg = chart.options.plugins && chart.options.plugins.factorMarkers;
      const lines = (cfg && cfg.lines) || [];
      const spans = (cfg && cfg.spans) || [];
      if (!lines.length && !spans.length) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;

      const bucketWidth =
        chart.data.labels.length > 1 ? scales.x.getPixelForValue(1) - scales.x.getPixelForValue(0) : chartArea.right - chartArea.left;

      ctx.save();
      spans.forEach((span) => {
        const x1 = scales.x.getPixelForValue(span.startIdx) - bucketWidth / 2;
        const x2 = scales.x.getPixelForValue(span.endIdx) + bucketWidth / 2;
        ctx.fillStyle = span.color;
        ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
      });
      lines.forEach((line) => {
        const x = scales.x.getPixelForValue(line.idx);
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      });
      ctx.restore();
    },
  };
  Chart.register(FACTOR_MARKERS_PLUGIN);

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
      <div class="field">
        <label>Factors</label>
        <div id="trends-factor-chips" class="chip-row"></div>
      </div>
      <div class="filter-bar">
        <select id="trends-range">
          ${RANGE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Chart Detail</label>
        <div class="granularity-row chip-row">
          <button type="button" class="chip" data-granularity="day">Day</button>
          <button type="button" class="chip" data-granularity="week">Week</button>
          <button type="button" class="chip" data-granularity="month">Month</button>
        </div>
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
      <div class="chart-card" id="temperature-chart-card" hidden>
        <h3>Temperature</h3>
        <div class="chart-wrap"><canvas id="temperature-chart"></canvas></div>
      </div>
    `;
  }

  /** Keeps the Day/Week/Month chips in sync with selectedGranularity. */
  function syncGranularityChips() {
    container.querySelectorAll(".granularity-row .chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", chip.dataset.granularity === selectedGranularity ? "true" : "false");
    });
  }

  /** Renders the tag/condition/factor filter chips, dropping any prior selection that no longer exists. */
  function populateFilterChips() {
    const tagNames = new Set(tags.map((t) => t.name));
    selectedTagNames.forEach((name) => {
      if (!tagNames.has(name)) selectedTagNames.delete(name);
    });
    const conditionNames = new Set(conditions.map((c) => c.name));
    selectedConditionNames.forEach((name) => {
      if (!conditionNames.has(name)) selectedConditionNames.delete(name);
    });
    const factorNames = new Set(factors.map((f) => f.name));
    selectedFactorNames.forEach((name) => {
      if (!factorNames.has(name)) selectedFactorNames.delete(name);
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
    // Factors don't filter the symptom data at all - selecting one just adds
    // the Factor Activity chart-card below, so this is genuinely multi-select
    // (unlike Reports' single-select symptom picker) and Pickers' own
    // per-button flip is sufficient - no full re-render needed here.
    Pickers.renderTagChips(container.querySelector("#trends-factor-chips"), factors, selectedFactorNames, (name) => {
      if (selectedFactorNames.has(name)) {
        selectedFactorNames.delete(name);
      } else {
        selectedFactorNames.add(name);
      }
      renderCharts();
    });
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
    if (temperatureChart) {
      temperatureChart.destroy();
      temperatureChart = null;
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
      noteEl.textContent = `Tracking started ${Bucketing.formatDate(
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

    const granularity = selectedGranularity;
    const buckets = Bucketing.buildBuckets(start, end, granularity);
    const labels = buckets.map((b) => Bucketing.formatBucketLabel(b, granularity));

    const freqCounts = buckets.map(() => 0);
    const sevSums = buckets.map(() => 0);
    const sevCounts = buckets.map(() => 0);

    filtered.forEach((e) => {
      const t = new Date(e.timestamp);
      const key = Bucketing.bucketKey(t, granularity);
      const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
      if (idx === -1) return;
      const occ = Analysis.occurrenceCount(e);
      freqCounts[idx] += occ;
      if (e.severity != null) {
        sevSums[idx] += e.severity * occ;
        sevCounts[idx] += occ;
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

    return { granularity, buckets, labels };
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
      span.textContent = `${w.name}: ${Bucketing.formatDate(w.tagFirstUsed || w.start)}`;
      noteEl.appendChild(span);
    });

    const granularity = selectedGranularity;
    const buckets = Bucketing.buildBuckets(sharedStart, now, granularity);
    const labels = buckets.map((b) => Bucketing.formatBucketLabel(b, granularity));

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
        const key = Bucketing.bucketKey(t, granularity);
        const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
        if (idx === -1) return;
        const occ = Analysis.occurrenceCount(e);
        counts[idx] += occ;
        if (e.severity != null) {
          sums[idx] += e.severity * occ;
          sevCounts[idx] += occ;
        }
      });

      // Null out any bucket before the one containing this symptom's own
      // window start, so its line simply doesn't appear yet rather than
      // showing a false flat zero. Compared as bucket keys, not raw
      // instants - w.start almost never falls exactly on a bucket boundary,
      // so comparing it directly against each bucket's start would wrongly
      // null out the whole bucket it actually starts in, discarding real
      // entries logged later that same week/month.
      const wStartKey = Bucketing.bucketKey(w.start, granularity);
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

    return { granularity, buckets, labels };
  }

  /**
   * Renders (or hides) the Temperature chart-card: readings averaged (not
   * summed) into the SAME buckets as the Frequency/Severity charts, so it
   * lines up on the same x-axis. Always-on rather than filter-gated - there's
   * only one series, unlike multi-select Factors - and hides itself whenever
   * no imported reading falls inside the current window.
   */
  function renderTemperatureChart(windowInfo) {
    const card = container.querySelector("#temperature-chart-card");
    if (!windowInfo || temperatures.length === 0) {
      card.hidden = true;
      return;
    }

    const { granularity, buckets, labels } = windowInfo;
    const sums = buckets.map(() => 0);
    const counts = buckets.map(() => 0);

    temperatures.forEach((t) => {
      const date = new Date(`${t.date}T12:00:00`); // noon-anchored: a date-only value, no real time-of-day
      const key = Bucketing.bucketKey(date, granularity);
      const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
      if (idx === -1) return;
      sums[idx] += t.value;
      counts[idx]++;
    });

    if (counts.every((c) => c === 0)) {
      card.hidden = true;
      return;
    }
    card.hidden = false;

    const averages = buckets.map((_, i) => (counts[i] ? +(sums[i] / counts[i]).toFixed(1) : null));

    temperatureChart = new Chart(container.querySelector("#temperature-chart").getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Avg temperature",
            data: averages,
            borderColor: SERIES_COLORS[2],
            backgroundColor: SERIES_COLORS[2],
            spanGaps: false,
            tension: 0.25,
            pointRadius: 3,
          },
        ],
      },
      options: chartOptions({ beginAtZero: false }, false),
    });
  }

  function factorDisplayType(name) {
    const record = factors.find((f) => f.name === name);
    return (record && record.displayType) || "bar";
  }

  /**
   * Assigns one stable color per selected factor, in selection order, offset
   * past however many symptom series are already using the front of
   * SERIES_COLORS (1 in single mode, N in compare mode) - so a factor never
   * visually collides with a symptom's own bar/line, and looks the same
   * color whether it ends up as a bar dataset, a line marker, or a span fill.
   */
  function computeFactorColors(symptomSeriesCount) {
    const map = new Map();
    Array.from(selectedFactorNames).forEach((name, i) => {
      map.set(name, SERIES_COLORS[(symptomSeriesCount + i) % SERIES_COLORS.length]);
    });
    return map;
  }

  /**
   * Line/span factors have no real Chart.js dataset (they're drawn by
   * FACTOR_MARKERS_PLUGIN's canvas overlay, not plotted data), so unlike a
   * bar factor's dataset they'd never show up in the legend on their own -
   * this builds the extra entries for them, deduped by name (a factor can
   * produce several marker entries - one per occurrence bucket or per span
   * cluster - but should only ever appear once in the legend).
   */
  function buildFactorLegendItems(markers) {
    const seen = new Map();
    markers.lines.forEach((l) => {
      if (!seen.has(l.name)) seen.set(l.name, l.color);
    });
    markers.spans.forEach((s) => {
      if (!seen.has(s.name)) seen.set(s.name, s.color);
    });
    return Array.from(seen.entries()).map(([name, color]) => ({
      text: name,
      fillStyle: color,
      strokeStyle: color,
      lineWidth: 0,
    }));
  }

  /**
   * Extends `chart`'s legend to also list any line/span factors currently
   * overlaid on it (bar-type factors already show up for free - they're
   * real datasets) and forces the legend on whenever there's anything to
   * show; never turns it back off, since a chart's own dataset-based
   * legend.display decision (compare mode, or a bar factor being present)
   * is the floor this only adds to.
   */
  function applyFactorLegend(chart, markers) {
    const extraItems = buildFactorLegendItems(markers);
    chart.options.plugins.legend.labels.generateLabels = (chartInstance) =>
      Chart.defaults.plugins.legend.labels.generateLabels(chartInstance).concat(extraItems);
    if (extraItems.length > 0) chart.options.plugins.legend.display = true;
  }

  /**
   * For each selected factor whose display type is "line" or "span" (set via
   * Data tab's Manage Factors list - "bar" is handled separately by
   * computeBarFactorDatasets), computes what to draw as an overlay on top of
   * the Frequency/Severity charts: "line" factors get one vertical marker
   * per occurrence bucket; "span" factors get a shaded rect per recurring
   * run of days, via Analysis.computeClusters (reusing the asTagEntries
   * adapter above) with a 1-day minimum - unlike Reports' Clusters section,
   * even a single isolated day of e.g. a period is worth shading here, not
   * filtered out as noise.
   */
  function computeFactorMarkers(windowInfo, colorMap) {
    if (!windowInfo) return { lines: [], spans: [] };
    const { granularity, buckets } = windowInfo;
    const lines = [];
    const spans = [];

    selectedFactorNames.forEach((name) => {
      const displayType = factorDisplayType(name);
      if (displayType === "bar") return;

      const color = colorMap.get(name);
      const theseEntries = factorEntries.filter((fe) => fe.name === name);

      if (displayType === "line") {
        theseEntries.forEach((fe) => {
          const t = new Date(fe.timestamp);
          const key = Bucketing.bucketKey(t, granularity);
          const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
          if (idx !== -1) lines.push({ idx, color, name });
        });
      } else if (displayType === "span") {
        const clusters = Analysis.computeClusters(asTagEntries(theseEntries), name, { maxGapDays: 1, minClusterDays: 1 });
        clusters.forEach((c) => {
          const startKey = Bucketing.bucketKey(c.startDate, granularity);
          const endKey = Bucketing.bucketKey(c.endDate, granularity);
          const startIdx = buckets.findIndex((b) => b.getTime() === startKey.getTime());
          const endIdx = buckets.findIndex((b) => b.getTime() === endKey.getTime());
          if (startIdx !== -1 && endIdx !== -1) spans.push({ startIdx, endIdx, color: hexToRgba(color, 0.18), name });
        });
      }
    });

    return { lines, spans };
  }

  /**
   * For each selected bar-type factor, one bar dataset counted into the SAME
   * buckets as the Frequency chart, on its own secondary (right-hand) y-axis
   * since a factor's raw occurrence count is a different scale than symptom
   * frequency - meant to be appended directly onto the Frequency chart's own
   * datasets (see renderCharts), not rendered as a separate chart.
   */
  function computeBarFactorDatasets(windowInfo, colorMap) {
    if (!windowInfo) return [];
    const { granularity, buckets } = windowInfo;

    return Array.from(selectedFactorNames)
      .filter((name) => factorDisplayType(name) === "bar")
      .map((name) => {
        const counts = buckets.map(() => 0);
        factorEntries
          .filter((f) => f.name === name)
          .forEach((f) => {
            const t = new Date(f.timestamp);
            const key = Bucketing.bucketKey(t, granularity);
            const idx = buckets.findIndex((b) => b.getTime() === key.getTime());
            if (idx !== -1) counts[idx]++;
          });
        const color = colorMap.get(name);
        return { type: "bar", label: name, data: counts, backgroundColor: color, borderColor: color, borderRadius: 4, yAxisID: "y1" };
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
      container.querySelector("#temperature-chart-card").hidden = true;
      return;
    }

    freqCard.hidden = false;
    sevCard.hidden = false;
    syncGranularityChips();

    const pool = conditionFilteredPool();
    const selected = Array.from(selectedTagNames);
    const symptomSeriesCount = selected.length >= 2 ? selected.length : 1;

    const windowInfo =
      selected.length >= 2
        ? renderCompareMode(pool, selected, noteEl, emptyEl)
        : renderSingleMode(pool, selected[0] || null, noteEl, emptyEl);

    const factorColors = computeFactorColors(symptomSeriesCount);
    const markers = computeFactorMarkers(windowInfo, factorColors);
    const barFactorDatasets = computeBarFactorDatasets(windowInfo, factorColors);

    if (freqChart) {
      freqChart.options.plugins.factorMarkers = markers;
      freqChart.data.datasets.push(...barFactorDatasets);
      if (barFactorDatasets.length > 0) {
        // A bar-type factor's raw occurrence count lives on its own
        // right-hand axis - a different scale than symptom frequency - and
        // forces the legend on so the extra series is actually labeled,
        // even in single-symptom mode where the legend is normally off.
        freqChart.options.scales.y1 = {
          position: "right",
          beginAtZero: true,
          ticks: { color: "#9fb0ac", stepSize: 1 },
          grid: { drawOnChartArea: false },
        };
        freqChart.options.plugins.legend.display = true;
      }
      applyFactorLegend(freqChart, markers);
      freqChart.update();
    }
    if (sevChart) {
      sevChart.options.plugins.factorMarkers = markers;
      applyFactorLegend(sevChart, markers);
      sevChart.update();
    }

    renderTemperatureChart(windowInfo);
  }

  async function loadData() {
    [entries, tags, conditions, factors, factorEntries, temperatures] = await Promise.all([
      DB.getAllEntries(),
      DB.getAllTags(),
      DB.getAllConditions(),
      DB.getAllFactors(),
      DB.getAllFactorEntries(),
      DB.getAllTemperatures(),
    ]);
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

    container.querySelectorAll(".granularity-row .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        selectedGranularity = chip.dataset.granularity;
        syncGranularityChips();
        renderCharts();
      });
    });
    syncGranularityChips();

    await loadData();
  }

  return { init, onShow: loadData };
})();

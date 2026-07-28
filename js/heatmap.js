/**
 * Shared GitHub-style contribution-heatmap math: day bucketing, color-level
 * mapping, and tooltip text. Pulled out of timeline.js (same "extract on
 * second use" precedent as js/bucketing.js) once reports.js needed the same
 * day-bucketing/color-level logic for a second, simpler, non-interactive
 * heatmap. Pure functions only - no DOM, no module-level state.
 */
const Heatmap = (() => {
  /** Local (not UTC) YYYY-MM-DD key, used to group entries by calendar day. */
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function startOfWeekSun(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  /** Builds `weeks` weeks of 7 days each, ending on the week containing `today`. */
  function buildHeatmapWeeks(weeks, today = new Date()) {
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    const firstWeekStart = startOfWeekSun(start);
    firstWeekStart.setDate(firstWeekStart.getDate() - (weeks - 1) * 7);

    const result = [];
    for (let w = 0; w < weeks; w++) {
      const weekStart = new Date(firstWeekStart);
      weekStart.setDate(weekStart.getDate() + w * 7);
      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(weekStart);
        date.setDate(date.getDate() + d);
        days.push(date);
      }
      result.push(days);
    }
    return result;
  }

  /** Maps a raw entry count to one of the heatmap's frequency-mode color levels (0-4). */
  function levelForCount(count) {
    if (count <= 0) return 0;
    if (count === 1) return 1;
    if (count === 2) return 2;
    if (count === 3) return 3;
    return 4;
  }

  /** Per-day entry count + severities (whichever color mode needs), keyed by dateKey. */
  function computeHeatmapDayStats(entries) {
    const stats = new Map();
    entries.forEach((e) => {
      const key = dateKey(new Date(e.timestamp));
      if (!stats.has(key)) stats.set(key, { count: 0, severities: [] });
      const day = stats.get(key);
      day.count++;
      if (e.severity != null) day.severities.push(e.severity);
    });
    return stats;
  }

  /**
   * Resolves one day's color level + tooltip for the given heatmap color
   * mode. Frequency reuses the existing 0-4 count-based levels; the two
   * severity modes reuse the app's 1-5 severity color scale directly (level
   * 0 means no severity was logged that day, distinct from no entries at all).
   */
  function describeHeatmapDay(stats, mode, dateLabel) {
    const count = stats ? stats.count : 0;
    const entryWord = count === 1 ? "entry" : "entries";

    if (mode === "frequency") {
      return { attr: "level", level: levelForCount(count), title: `${count} ${entryWord} on ${dateLabel}` };
    }

    const severities = stats ? stats.severities : [];
    if (severities.length === 0) {
      const suffix = count > 0 ? ` (${count} ${entryWord}, no severity logged)` : "";
      return { attr: "sevLevel", level: 0, title: `No severity data on ${dateLabel}${suffix}` };
    }

    const value =
      mode === "avgSeverity" ? severities.reduce((a, b) => a + b, 0) / severities.length : Math.max(...severities);
    const level = Math.max(1, Math.min(5, Math.round(value)));
    const label = mode === "avgSeverity" ? "avg severity" : "max severity";
    const valueLabel = mode === "avgSeverity" ? value.toFixed(1) : String(value);
    return { attr: "sevLevel", level, title: `${label} ${valueLabel} (${count} ${entryWord}) on ${dateLabel}` };
  }

  /** Shared legend shape (attr/swatch count/end labels) so every heatmap's legend can't drift. */
  function legendSpec(mode) {
    return mode === "frequency"
      ? { attr: "level", swatchCount: 5, startLabel: "Less", endLabel: "More" }
      : { attr: "sevLevel", swatchCount: 6, startLabel: "Mild", endLabel: "Severe" };
  }

  return { dateKey, buildHeatmapWeeks, levelForCount, computeHeatmapDayStats, describeHeatmapDay, legendSpec };
})();

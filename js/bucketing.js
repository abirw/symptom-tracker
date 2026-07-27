/**
 * Shared date-bucketing helpers for turning a list of timestamps into
 * weekly/monthly chart buckets. Originally private to trends.js; extracted
 * once reports.js needed the exact same logic for its own mini-charts and
 * the note-word "mentions over time" chart, so both stay in sync.
 */
const Bucketing = (() => {
  /** Local midnight for `date` (used to group entries into daily buckets). */
  function bucketKeyDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

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

  /** `date`'s bucket start for any of the three granularities - the single dispatch point every caller should use instead of its own ternary. */
  function bucketKey(date, granularity) {
    if (granularity === "day") return bucketKeyDay(date);
    if (granularity === "week") return bucketKeyWeek(date);
    return bucketKeyMonth(date);
  }

  /** Short windows get weekly bars/points; longer ones switch to monthly so the chart stays readable. Never picks "day" - that's opt-in only (Trends' manual granularity toggle). */
  function chooseGranularity(start, end) {
    const spanDays = (end - start) / 86400000;
    return spanDays <= 70 ? "week" : "month";
  }

  /** Generates every bucket start date from `start` to `end`, inclusive, at the given granularity. */
  function buildBuckets(start, end, granularity) {
    const buckets = [];
    const cur = bucketKey(start, granularity);
    const endKey = bucketKey(end, granularity);
    while (cur.getTime() <= endKey.getTime()) {
      buckets.push(new Date(cur));
      if (granularity === "day") {
        cur.setDate(cur.getDate() + 1);
      } else if (granularity === "week") {
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
    if (granularity === "day") {
      return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    return granularity === "week"
      ? `Wk of ${new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : new Date(date).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  return { bucketKeyDay, bucketKeyWeek, bucketKeyMonth, bucketKey, chooseGranularity, buildBuckets, formatDate, formatBucketLabel };
})();

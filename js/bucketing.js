/**
 * Shared date-bucketing helpers for turning a list of timestamps into
 * weekly/monthly chart buckets. Originally private to trends.js; extracted
 * once reports.js needed the exact same logic for its own mini-charts and
 * the note-word "mentions over time" chart, so both stay in sync.
 */
const Bucketing = (() => {
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

  return { bucketKeyWeek, bucketKeyMonth, chooseGranularity, buildBuckets, formatDate, formatBucketLabel };
})();

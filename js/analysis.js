/**
 * Pure analysis functions for the Reports tab (and any future Trends views).
 * No DOM, no IndexedDB - takes an already-filtered `entries` array (plus a
 * focus tag name where relevant) and returns plain data, so every algorithm
 * here is unit-testable in a plain Node harness, same as importer.js.
 */
const Analysis = (() => {
  const STOPWORDS = new Set([
    "the", "and", "for", "that", "this", "with", "was", "were", "have", "has",
    "had", "not", "but", "you", "your", "then", "than", "when", "what", "which",
    "who", "whom", "will", "would", "could", "should", "can", "just", "into",
    "onto", "off", "out", "over", "under", "again", "there", "here", "about",
    "after", "before", "during", "while", "because", "also", "very", "much",
    "more", "most", "some", "any", "all", "each", "every", "other", "such",
    "only", "own", "same", "still", "yet", "did", "does", "doing", "been",
    "being", "are", "was", "his", "her", "their", "its", "our", "them", "they",
    "these", "those", "from", "get", "got", "went", "going", "day", "days",
    "today", "yesterday", "felt", "feel", "feeling", "like", "really", "quite",
    "bit", "little", "lot", "one", "two", "around", "again",
    "trying", "few", "episodes", "episode",
  ]);

  /** Local (not UTC) midnight for `date`, used to compare/bucket by calendar day. */
  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Local calendar-day key, e.g. "2026-07-21" - used to dedupe same-day entries. */
  function dayKey(date) {
    const d = startOfDay(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Whole-day difference between two dates (b - a), truncated to a calendar-day count. */
  function dayDiff(a, b) {
    return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000);
  }

  function entriesWithTag(entries, tagName) {
    if (!tagName) return entries.slice();
    return entries.filter((e) => (e.tags || []).includes(tagName));
  }

  /** Distinct, sorted (ascending) calendar days on which `tagName` occurred at least once. */
  function distinctOccurrenceDays(entries, tagName) {
    const keys = new Set(entriesWithTag(entries, tagName).map((e) => dayKey(e.timestamp)));
    return [...keys].sort().map((k) => new Date(`${k}T00:00:00`));
  }

  /** Counts per weekday (Sun=0 .. Sat=6), in that order. */
  function computeDayOfWeekDistribution(entries) {
    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const counts = labels.map(() => 0);
    entries.forEach((e) => {
      counts[new Date(e.timestamp).getDay()]++;
    });
    return labels.map((day, i) => ({ day, count: counts[i] }));
  }

  /** Counts per severity level 1-5; entries with no severity are excluded. */
  function computeSeverityDistribution(entries) {
    const counts = [0, 0, 0, 0, 0];
    entries.forEach((e) => {
      if (e.severity >= 1 && e.severity <= 5) counts[e.severity - 1]++;
    });
    return counts.map((count, i) => ({ severity: i + 1, count }));
  }

  /**
   * Counts entries per time-of-day value, in the order `options` gives them
   * (Log's TIME_OF_DAY_OPTIONS, passed in by the caller so this stays
   * framework-free rather than importing LogView's list directly); entries
   * with no timeOfDay set are excluded, same exclusion rule as
   * computeSeverityDistribution.
   */
  function computeTimeOfDayDistribution(entries, options) {
    const counts = new Map(options.map((o) => [o.value, 0]));
    entries.forEach((e) => {
      if (e.timeOfDay && counts.has(e.timeOfDay)) counts.set(e.timeOfDay, counts.get(e.timeOfDay) + 1);
    });
    return options.map((o) => ({ value: o.value, label: o.label, count: counts.get(o.value) }));
  }

  /**
   * For every calendar day `focusTagName` occurred, tallies every *other* tag
   * that also appeared that day (any entry that day, not just the same
   * entry). Returns a ranked list of co-occurring symptoms.
   */
  function computeCoOccurrence(entries, focusTagName) {
    const focusDayKeys = new Set(entriesWithTag(entries, focusTagName).map((e) => dayKey(e.timestamp)));
    const totalDays = focusDayKeys.size;

    const tagDayPresence = new Map(); // name -> Set of day keys

    entries.forEach((e) => {
      const key = dayKey(e.timestamp);
      if (!focusDayKeys.has(key)) return;
      (e.tags || []).forEach((name) => {
        if (name === focusTagName) return;
        if (!tagDayPresence.has(name)) tagDayPresence.set(name, new Set());
        tagDayPresence.get(name).add(key);
      });
    });

    const tags = [...tagDayPresence.entries()]
      .map(([name, days]) => ({
        name,
        count: days.size,
        percentOfDays: totalDays ? Math.round((days.size / totalDays) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return { totalDays, tags };
  }

  /**
   * Same day-based tally as computeCoOccurrence, but against a separate
   * `factorEntries` array (period, heatwaves, medication changes, etc.)
   * instead of the same entries' own tags - "was this factor active on the
   * days this symptom occurred?".
   */
  function computeFactorCoOccurrence(entries, focusTagName, factorEntries) {
    const focusDayKeys = new Set(entriesWithTag(entries, focusTagName).map((e) => dayKey(e.timestamp)));
    const totalDays = focusDayKeys.size;

    const factorDayPresence = new Map(); // name -> Set of day keys

    factorEntries.forEach((f) => {
      const key = dayKey(f.timestamp);
      if (!focusDayKeys.has(key)) return;
      if (!factorDayPresence.has(f.name)) factorDayPresence.set(f.name, new Set());
      factorDayPresence.get(f.name).add(key);
    });

    const factors = [...factorDayPresence.entries()]
      .map(([name, days]) => ({
        name,
        count: days.size,
        percentOfDays: totalDays ? Math.round((days.size / totalDays) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    return { totalDays, factors };
  }

  /**
   * The mirror image of computeFactorCoOccurrence: for every day
   * `focusFactorName` was active, tallies which symptom tags appeared that
   * day (any entry, not just one) - "what commonly happens on these days"
   * rather than "which factors show up on this symptom's days". Also
   * reports the average severity of entries on those days vs the pool's
   * overall average, the same severity-delta signal computeNoteWordFrequency
   * already gives for note words.
   */
  function computeSymptomsOnFactorDays(factorEntries, focusFactorName, entries) {
    const focusDayKeys = new Set(
      factorEntries.filter((fe) => fe.name === focusFactorName).map((fe) => dayKey(fe.timestamp))
    );
    const totalDays = focusDayKeys.size;

    const tagDayPresence = new Map(); // name -> Set of day keys
    const onDayEntries = [];

    entries.forEach((e) => {
      const key = dayKey(e.timestamp);
      if (!focusDayKeys.has(key)) return;
      onDayEntries.push(e);
      (e.tags || []).forEach((name) => {
        if (!tagDayPresence.has(name)) tagDayPresence.set(name, new Set());
        tagDayPresence.get(name).add(key);
      });
    });

    const tags = [...tagDayPresence.entries()]
      .map(([name, days]) => ({
        name,
        count: days.size,
        percentOfDays: totalDays ? Math.round((days.size / totalDays) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const avg = (list) => (list.length ? Math.round((list.reduce((s, e) => s + e.severity, 0) / list.length) * 10) / 10 : null);
    const avgSeverityOnDays = avg(onDayEntries.filter((e) => e.severity != null));
    const overallAvgSeverity = avg(entries.filter((e) => e.severity != null));

    return { totalDays, tags, avgSeverityOnDays, overallAvgSeverity };
  }

  /**
   * For each factor, checks whether it was active exactly N days before each
   * of focusTagName's occurrence-days, for N from 1 to maxLagDays, and keeps
   * whichever lag matches the most days - "this factor is most predictive N
   * days ahead of this symptom". Lag 0 (same-day) is intentionally excluded;
   * that's what computeFactorCoOccurrence already covers. A factor that
   * never precedes the symptom at any tested lag is omitted entirely.
   */
  function computeLaggedFactorCorrelation(entries, focusTagName, factorEntries, { maxLagDays = 3 } = {}) {
    const focusDays = distinctOccurrenceDays(entries, focusTagName);
    const totalDays = focusDays.length;
    if (totalDays === 0) return { totalDays: 0, results: [] };

    const factorDaysByName = new Map(); // name -> Set of day keys
    factorEntries.forEach((f) => {
      if (!factorDaysByName.has(f.name)) factorDaysByName.set(f.name, new Set());
      factorDaysByName.get(f.name).add(dayKey(f.timestamp));
    });

    const results = [];
    for (const [name, daySet] of factorDaysByName) {
      let bestLag = null;
      let bestCount = 0;
      for (let lag = 1; lag <= maxLagDays; lag++) {
        const count = focusDays.filter((symptomDay) => {
          const priorDay = new Date(symptomDay);
          priorDay.setDate(priorDay.getDate() - lag);
          return daySet.has(dayKey(priorDay));
        }).length;
        if (count > bestCount) {
          bestCount = count;
          bestLag = lag;
        }
      }
      if (bestCount > 0) {
        results.push({
          name,
          lagDays: bestLag,
          count: bestCount,
          percentOfDays: Math.round((bestCount / totalDays) * 1000) / 10,
        });
      }
    }

    results.sort((a, b) => b.percentOfDays - a.percentOfDays || a.name.localeCompare(b.name));

    return { totalDays, results };
  }

  /**
   * Distinct-day streak/gap stats for `focusTagName`. `longestGapDays` also
   * considers the current ongoing gap (days since the last occurrence) as a
   * candidate, so "it's been 45 days" can itself be the record. `averageGapDays`
   * and `shortestGapDays` only reflect completed historical gaps.
   */
  function computeStreaksAndGaps(entries, focusTagName, now) {
    const days = distinctOccurrenceDays(entries, focusTagName);
    if (days.length === 0) {
      return {
        occurrenceDayCount: 0,
        daysSinceLast: null,
        longestGapDays: null,
        averageGapDays: null,
        shortestGapDays: null,
      };
    }

    const gaps = [];
    for (let i = 1; i < days.length; i++) {
      gaps.push(dayDiff(days[i - 1], days[i]));
    }

    const daysSinceLast = dayDiff(days[days.length - 1], now);
    const longestCandidates = gaps.concat([daysSinceLast]);

    return {
      occurrenceDayCount: days.length,
      daysSinceLast,
      longestGapDays: Math.max(...longestCandidates),
      averageGapDays: gaps.length ? Math.round((gaps.reduce((s, g) => s + g, 0) / gaps.length) * 10) / 10 : null,
      shortestGapDays: gaps.length ? Math.min(...gaps) : null,
    };
  }

  /**
   * Groups distinct occurrence-days into "episodes": runs where consecutive
   * occurrence-days are no more than `maxGapDays` blank days apart. Same-day
   * duplicate entries are deduped to one occurrence-day first, so intentional
   * duplicates (e.g. splitting out several episodes logged the same day)
   * don't inflate a cluster's day count.
   */
  function computeClusters(entries, focusTagName, { maxGapDays = 1, minClusterDays = 2 } = {}) {
    const days = distinctOccurrenceDays(entries, focusTagName);
    if (days.length === 0) return [];

    const runs = [];
    let current = [days[0]];
    for (let i = 1; i < days.length; i++) {
      if (dayDiff(days[i - 1], days[i]) <= maxGapDays + 1) {
        current.push(days[i]);
      } else {
        runs.push(current);
        current = [days[i]];
      }
    }
    runs.push(current);

    const tagEntries = entriesWithTag(entries, focusTagName);

    return runs
      .filter((run) => run.length >= minClusterDays)
      .map((run) => {
        const startDate = run[0];
        const endDate = run[run.length - 1];
        const endOfEndDate = new Date(endDate);
        endOfEndDate.setHours(23, 59, 59, 999);
        const inRange = tagEntries.filter((e) => {
          const t = new Date(e.timestamp);
          return t >= startDate && t <= endOfEndDate;
        });
        const withSeverity = inRange.filter((e) => e.severity != null);
        return {
          startDate,
          endDate,
          dayCount: run.length,
          entryCount: inRange.length,
          avgSeverity: withSeverity.length
            ? Math.round((withSeverity.reduce((s, e) => s + e.severity, 0) / withSeverity.length) * 10) / 10
            : null,
          maxSeverity: withSeverity.length ? Math.max(...withSeverity.map((e) => e.severity)) : null,
        };
      });
  }

  function tokenize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  }

  /**
   * Ranks the most frequent words across all notes (by number of entries
   * mentioning the word, not raw occurrence count), and for each reports the
   * average severity of entries that mention it vs the pool's overall average
   * - e.g. "entries mentioning 'stress' average 4.1 vs your overall 2.8".
   */
  function computeNoteWordFrequency(entries, { topN = 15 } = {}) {
    const withSeverity = entries.filter((e) => e.severity != null);
    const overallAvgSeverity = withSeverity.length
      ? Math.round((withSeverity.reduce((s, e) => s + e.severity, 0) / withSeverity.length) * 10) / 10
      : null;

    const wordEntries = new Map(); // word -> array of entries mentioning it

    entries.forEach((e) => {
      const words = new Set(tokenize(e.note));
      words.forEach((w) => {
        if (!wordEntries.has(w)) wordEntries.set(w, []);
        wordEntries.get(w).push(e);
      });
    });

    return {
      overallAvgSeverity,
      words: [...wordEntries.entries()]
        .map(([word, list]) => {
          const listWithSeverity = list.filter((e) => e.severity != null);
          return {
            word,
            count: list.length,
            avgSeverityWithWord: listWithSeverity.length
              ? Math.round((listWithSeverity.reduce((s, e) => s + e.severity, 0) / listWithSeverity.length) * 10) / 10
              : null,
          };
        })
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
        .slice(0, topN),
    };
  }

  return {
    computeDayOfWeekDistribution,
    computeSeverityDistribution,
    computeTimeOfDayDistribution,
    computeCoOccurrence,
    computeFactorCoOccurrence,
    computeSymptomsOnFactorDays,
    computeLaggedFactorCorrelation,
    computeStreaksAndGaps,
    computeClusters,
    computeNoteWordFrequency,
    tokenize,
    dayKey,
    dayDiff,
  };
})();

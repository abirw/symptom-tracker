/**
 * Parsing for the Import feature. Five input shapes, all handled here as
 * pure functions (no DOM, no IndexedDB) so the Data view (data.js) only has
 * to render what these return and let the user confirm:
 *
 *  - parseJsonBackup: this app's own JSON export format (full fidelity).
 *  - csvToEntries: this app's own CSV export format (id/timestamp/tags/
 *    conditions/severity/note columns, "conditions" falling back to a
 *    singular "condition" column from an older export), also tolerant of
 *    a hand-made CSV that only has some of those columns.
 *  - parseTextToCandidates: a local heuristic over a plain-text journal.
 *    No AI/network involved by design (see SPEC.md's local-first
 *    principle) - it only recognizes tags/conditions you've already
 *    created, which is why its output is always a review-before-import
 *    list rather than something committed straight to the DB.
 *  - parseTemperatureFile: one daily reading per line (`YYYY-MM-DD` then a
 *    decimal value), for the separate "Import Temperature Data" section.
 *  - parseFactorLogFile: one factor occurrence per line (`YYYY-MM-DD <name>`),
 *    or a date range on one line, for the "Import Factor Log" section.
 */
const Importer = (() => {
  // ---- JSON backup (mirrors export.js's exportJson payload shape) ----

  /** Normalizes a possibly-old-shape entry (single `condition` string) to the current `conditions` array shape. */
  function normalizeEntryConditions(entry) {
    if (Array.isArray(entry.conditions)) return entry;
    const { condition, ...rest } = entry;
    return { ...rest, conditions: condition ? [condition] : [] };
  }

  /**
   * @param {string} text - raw file contents
   * @returns {{entries: object[], tags: object[], conditions: object[], factorEntries: object[], factors: object[], temperatures: object[]}}
   * @throws if the JSON doesn't look like one of this app's own exports
   */
  function parseJsonBackup(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
      throw new Error("This doesn't look like a Symptom Tracker JSON export.");
    }
    return {
      // Older exports (before an entry could have multiple conditions) used
      // a single `condition` string - normalize those on the way in.
      entries: data.entries.map(normalizeEntryConditions),
      tags: Array.isArray(data.tags) ? data.tags : [],
      conditions: Array.isArray(data.conditions) ? data.conditions : [],
      // All three are newer than the original export format - default to
      // empty so a backup made before Factors/Temperature existed still imports.
      factorEntries: Array.isArray(data.factorEntries) ? data.factorEntries : [],
      factors: Array.isArray(data.factors) ? data.factors : [],
      temperatures: Array.isArray(data.temperatures) ? data.temperatures : [],
    };
  }

  // ---- CSV ----

  /** Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas/newlines, and "" escaping. */
  function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
        continue;
      }
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\r") {
        // ignore; the following \n (or end of a lone \r line) ends the row
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  }

  /** Splits a semicolon- or comma-separated cell into trimmed, non-empty values (used for tags and conditions alike). */
  function splitMultiValue(cell) {
    if (!cell) return [];
    return cell
      .split(/;|,/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /**
   * @param {string} text - raw CSV file contents
   * @returns {object[]} entry-shaped objects (id may be null - caller generates one)
   * @throws if there's no "timestamp" column
   */
  function csvToEntries(text) {
    const rows = parseCsvRows(text);
    if (rows.length === 0) return [];

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name);
    const idCol = col("id");
    const tsCol = col("timestamp");
    const tagsCol = col("tags");
    // "conditions" is the current column name; "condition" (singular) is
    // read too so a CSV exported before multi-condition support still imports.
    const condCol = col("conditions") !== -1 ? col("conditions") : col("condition");
    const sevCol = col("severity");
    const noteCol = col("note");

    if (tsCol === -1) {
      throw new Error('CSV needs at least a "timestamp" column.');
    }

    return rows
      .slice(1)
      .map((r) => {
        const parsedDate = new Date(r[tsCol]);
        if (isNaN(parsedDate.getTime())) return null; // skip rows with an unparseable date

        const severityRaw = sevCol !== -1 ? r[sevCol] : "";
        const severity = severityRaw && !isNaN(Number(severityRaw)) ? Number(severityRaw) : null;

        return {
          id: idCol !== -1 && r[idCol] ? r[idCol].trim() : null,
          timestamp: parsedDate.toISOString(),
          tags: tagsCol !== -1 ? splitMultiValue(r[tagsCol]) : [],
          conditions: condCol !== -1 ? splitMultiValue(r[condCol]) : [],
          severity,
          note: noteCol !== -1 ? r[noteCol] || "" : "",
        };
      })
      .filter(Boolean);
  }

  // ---- Plain-text heuristic extraction ----

  const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MONTHS_ALT = MONTH_NAMES.join("|");

  /**
   * Looks for a date-like substring at the start of a line. Missing years
   * are assumed to be this year, unless that lands in the future (common in
   * a journal spanning a year boundary), in which case it rolls back one year.
   *
   * Dates are anchored to local noon rather than midnight: these lines carry
   * no time-of-day, and noon is safely clear of any UTC-conversion or
   * timezone-shift ever flipping the stored instant onto the adjacent
   * calendar day when it's redisplayed.
   * @returns {{date: Date, matchText: string}|null}
   */
  function tryParseDate(line, now) {
    let m = line.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) {
      return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12), matchText: m[0] };
    }

    m = line.match(new RegExp(`\\b(${MONTHS_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?`, "i"));
    if (m) {
      const month = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase());
      const day = Number(m[2]);
      const year = m[3] ? Number(m[3]) : now.getFullYear();
      const date = new Date(year, month, day, 12);
      if (!m[3] && date > now) date.setFullYear(date.getFullYear() - 1);
      return { date, matchText: m[0] };
    }

    m = line.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const month = Number(m[1]) - 1;
      const day = Number(m[2]);
      let year = m[3] != null ? Number(m[3]) : now.getFullYear();
      if (year < 100) year += 2000;
      const date = new Date(year, month, day, 12);
      if (m[3] == null && date > now) date.setFullYear(date.getFullYear() - 1);
      return { date, matchText: m[0] };
    }

    return null;
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const SEVERITY_KEYWORDS = [
    [/\b(unbearable|excruciating|worst)\b/i, 5],
    [/\bsevere\b/i, 4],
    [/\bmoderate\b/i, 3],
    [/\bmild\b/i, 2],
    [/\b(slight|minor|minimal)\b/i, 1],
  ];

  /** Explicit numeric hints ("4/5", "severity: 3") win; falls back to mild/moderate/severe-style keywords. */
  function guessSeverity(text) {
    let m = text.match(/\b([1-5])\s*\/\s*5\b/);
    if (m) return Number(m[1]);

    m = text.match(/\b(?:severity|pain|level)\s*[:\-]?\s*([1-5])\b/i);
    if (m) return Number(m[1]);

    for (const [re, level] of SEVERITY_KEYWORDS) {
      if (re.test(text)) return level;
    }
    return null;
  }

  /** Every existing tag name that appears (whole-word, case-insensitive) in `text`. */
  function guessTags(text, tagNames) {
    return tagNames.filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text));
  }

  /** Every existing condition name that appears (whole-word, case-insensitive) in `text`. */
  function guessConditions(text, conditionNames) {
    return conditionNames.filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text));
  }

  function buildCandidate(noteText, date, tagNames, conditionNames) {
    return {
      timestamp: date ? date.toISOString() : null,
      tags: guessTags(noteText, tagNames),
      conditions: guessConditions(noteText, conditionNames),
      severity: guessSeverity(noteText),
      note: noteText,
    };
  }

  /**
   * Splits free-form text into candidate entries. A line that looks like it
   * starts with a date opens a new entry; every line after it (until the
   * next date line) becomes that entry's note. If no date-like line is
   * found anywhere, falls back to treating each blank-line-separated
   * paragraph as its own (undated) candidate.
   * @param {string} text
   * @param {string[]} tagNames - existing tag names to match against
   * @param {string[]} conditionNames - existing condition names to match against
   * @param {Date} [now]
   * @returns {object[]} candidates: {timestamp: string|null, tags: string[], conditions: string[], severity: number|null, note: string}
   */
  function parseTextToCandidates(text, tagNames, conditionNames, now = new Date()) {
    const lines = text.split(/\r\n|\r|\n/);
    const blocks = []; // { date: Date|null, lines: string[] }

    lines.forEach((line) => {
      const trimmed = line.trim();
      const parsed = trimmed ? tryParseDate(trimmed, now) : null;
      if (parsed) {
        const remainder = trimmed.replace(parsed.matchText, "").replace(/^[\s:.\-–—,]+/, "");
        blocks.push({ date: parsed.date, lines: remainder ? [remainder] : [] });
      } else if (blocks.length > 0) {
        blocks[blocks.length - 1].lines.push(line);
      } else if (trimmed) {
        blocks.push({ date: null, lines: [line] });
      }
    });

    const anyDated = blocks.some((b) => b.date !== null);
    if (!anyDated) {
      return text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => buildCandidate(p, null, tagNames, conditionNames));
    }

    return blocks
      .map((b) => buildCandidate(b.lines.join("\n").trim(), b.date, tagNames, conditionNames))
      .filter((c) => c.note || c.tags.length || c.conditions.length || c.severity != null);
  }

  // ---- Temperature log ----

  const TEMPERATURE_LINE_RE = /^(\d{4}-\d{2}-\d{2})\s+(-?\d+(?:\.\d+)?)$/;

  /**
   * Parses a plain-text temperature log: one reading per non-blank line,
   * `YYYY-MM-DD` followed by whitespace and a decimal value (negative
   * allowed), e.g. "2026-01-01    6.0". Lines that don't match, or whose
   * date isn't a real calendar date, are skipped and counted separately
   * rather than aborting the whole file. A date repeated within the file
   * keeps only its last occurrence (a plain Map), matching how re-importing
   * an overlapping file later overwrites via `put`.
   * @param {string} text
   * @returns {{readings: {date: string, value: number}[], skippedCount: number}}
   */
  function parseTemperatureFile(text) {
    const byDate = new Map();
    let skippedCount = 0;

    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const match = trimmed.match(TEMPERATURE_LINE_RE);
      if (!match || isNaN(new Date(match[1]).getTime())) {
        skippedCount++;
        return;
      }

      byDate.set(match[1], { date: match[1], value: parseFloat(match[2]) });
    });

    return { readings: [...byDate.values()], skippedCount };
  }

  // ---- Factor log ----

  const FACTOR_RANGE_LINE_RE = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/i;
  const FACTOR_SINGLE_LINE_RE = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/;

  /** Every calendar date from `startStr` to `endStr`, inclusive, as `YYYY-MM-DD` strings. */
  function dateRangeStrings(startStr, endStr) {
    const [sy, sm, sd] = startStr.split("-").map(Number);
    const [ey, em, ed] = endStr.split("-").map(Number);
    const cur = new Date(sy, sm - 1, sd);
    const end = new Date(ey, em - 1, ed);
    const dates = [];
    while (cur.getTime() <= end.getTime()) {
      dates.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
      cur.setDate(cur.getDate() + 1);
    }
    return dates;
  }

  /**
   * Parses a plain-text factor log. Each non-blank line is either a single
   * day (`YYYY-MM-DD <name>`, e.g. "2026-07-21 period") or an explicit range
   * (`YYYY-MM-DD to YYYY-MM-DD <name>`, e.g. "2026-07-21 to 2026-07-25 period"),
   * which is expanded into one entry per day, inclusive - factors are always
   * logged as individual days (see db.js), never stored as a date range.
   * A reversed range (end before start) or an unparseable date is skipped
   * and counted rather than aborting the whole file. Same date+name repeated
   * within the file (including via overlapping ranges) is deduped to one entry.
   * @param {string} text
   * @returns {{entries: {date: string, name: string}[], skippedCount: number}}
   */
  function parseFactorLogFile(text) {
    const seen = new Set(); // `${date}|${name}` - dedupes within the file
    const entries = [];
    let skippedCount = 0;

    const addEntry = (date, rawName) => {
      const name = rawName.trim();
      const key = `${date}|${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ date, name });
    };

    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const rangeMatch = trimmed.match(FACTOR_RANGE_LINE_RE);
      if (rangeMatch) {
        const [, startStr, endStr, name] = rangeMatch;
        const start = new Date(startStr);
        const end = new Date(endStr);
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) {
          skippedCount++;
          return;
        }
        dateRangeStrings(startStr, endStr).forEach((date) => addEntry(date, name));
        return;
      }

      const singleMatch = trimmed.match(FACTOR_SINGLE_LINE_RE);
      if (!singleMatch || isNaN(new Date(singleMatch[1]).getTime())) {
        skippedCount++;
        return;
      }
      addEntry(singleMatch[1], singleMatch[2]);
    });

    return { entries, skippedCount };
  }

  return { parseJsonBackup, csvToEntries, parseTextToCandidates, parseTemperatureFile, parseFactorLogFile };
})();

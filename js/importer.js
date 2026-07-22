/**
 * Parsing for the Import feature. Three input shapes, all handled here as
 * pure functions (no DOM, no IndexedDB) so the Data view (data.js) only has
 * to render what these return and let the user confirm:
 *
 *  - parseJsonBackup: this app's own JSON export format (full fidelity).
 *  - csvToEntries: this app's own CSV export format (id/timestamp/tags/
 *    condition/severity/note columns), also tolerant of a hand-made CSV
 *    that only has some of those columns.
 *  - parseTextToCandidates: a local heuristic over a plain-text journal.
 *    No AI/network involved by design (see SPEC.md's local-first
 *    principle) - it only recognizes tags/conditions you've already
 *    created, which is why its output is always a review-before-import
 *    list rather than something committed straight to the DB.
 */
const Importer = (() => {
  // ---- JSON backup (mirrors export.js's exportJson payload shape) ----

  /**
   * @param {string} text - raw file contents
   * @returns {{entries: object[], tags: object[], conditions: object[]}}
   * @throws if the JSON doesn't look like one of this app's own exports
   */
  function parseJsonBackup(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
      throw new Error("This doesn't look like a Symptom Tracker JSON export.");
    }
    return {
      entries: data.entries,
      tags: Array.isArray(data.tags) ? data.tags : [],
      conditions: Array.isArray(data.conditions) ? data.conditions : [],
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

  function splitTags(cell) {
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
    const condCol = col("condition");
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
          tags: tagsCol !== -1 ? splitTags(r[tagsCol]) : [],
          condition: condCol !== -1 && r[condCol] ? r[condCol].trim() : null,
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

  /** The first existing condition name that appears in `text` (conditions are single-select). */
  function guessCondition(text, conditionNames) {
    return conditionNames.find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(text)) || null;
  }

  function buildCandidate(noteText, date, tagNames, conditionNames) {
    return {
      timestamp: date ? date.toISOString() : null,
      tags: guessTags(noteText, tagNames),
      condition: guessCondition(noteText, conditionNames),
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
   * @returns {object[]} candidates: {timestamp: string|null, tags: string[], condition: string|null, severity: number|null, note: string}
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
      .filter((c) => c.note || c.tags.length || c.severity != null);
  }

  return { parseJsonBackup, csvToEntries, parseTextToCandidates };
})();

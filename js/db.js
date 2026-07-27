/**
 * Hand-rolled IndexedDB wrapper — no external dependency. Exposes six object
 * stores: `entries` (the logged symptom entries), `tags` and `conditions`
 * (both "grow as you go" lookup lists per SPEC.md), `factorEntries`/`factors`
 * — a parallel, simpler log for things like period, heatwaves, or medication
 * changes that aren't symptoms themselves but help explain symptom patterns
 * (deliberately kept separate from `entries`) — and `temperatures`, one
 * value per calendar day, imported from a text file rather than logged by
 * hand. Every public method returns a Promise; there is no in-memory cache
 * here, callers (the view modules) hold their own copies for the duration
 * of a render.
 */
const DB = (() => {
  const DB_NAME = "symptom-tracker";
  const DB_VERSION = 4;

  let dbPromise = null;

  /**
   * Opens (or creates, on first run) the database and its object stores.
   * Safe to call repeatedly — the underlying open request only happens once
   * per page load, subsequent calls just await the same cached promise.
   * @returns {Promise<IDBDatabase>}
   */
  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        const transaction = event.target.transaction;

        if (event.oldVersion < 1) {
          const entries = db.createObjectStore("entries", { keyPath: "id" });
          entries.createIndex("timestamp", "timestamp");
          entries.createIndex("tags", "tags", { multiEntry: true });
          entries.createIndex("conditions", "conditions", { multiEntry: true });

          db.createObjectStore("tags", { keyPath: "name" });
          db.createObjectStore("conditions", { keyPath: "name" });
        }

        if (event.oldVersion < 2) {
          // v1 -> v2: an entry's `condition` (single string) becomes
          // `conditions` (an array) - an entry can belong to more than one
          // consultant/condition. Swap the single-value index for a
          // multiEntry one (mirroring `tags`), then rewrite every existing
          // entry in place so nothing is ever silently dropped.
          const entries = transaction.objectStore("entries");
          if (entries.indexNames.contains("condition")) {
            entries.deleteIndex("condition");
          }
          if (!entries.indexNames.contains("conditions")) {
            entries.createIndex("conditions", "conditions", { multiEntry: true });
          }

          entries.openCursor().onsuccess = (cursorEvent) => {
            const cursor = cursorEvent.target.result;
            if (!cursor) return;
            const record = cursor.value;
            if (!Array.isArray(record.conditions)) {
              record.conditions = record.condition ? [record.condition] : [];
              delete record.condition;
              cursor.update(record);
            }
            cursor.continue();
          };
        }

        if (event.oldVersion < 3) {
          // v2 -> v3: adds the "other factors" log (period, heatwaves,
          // medication changes, etc.) - a parallel, simpler store alongside
          // the existing ones. Purely additive: nothing here touches
          // entries/tags/conditions.
          db.createObjectStore("factors", { keyPath: "name" });
          const factorEntries = db.createObjectStore("factorEntries", { keyPath: "id" });
          factorEntries.createIndex("timestamp", "timestamp");
          factorEntries.createIndex("name", "name");
        }

        if (event.oldVersion < 4) {
          // v3 -> v4: adds imported daily temperature readings. Keyed by
          // date (not id) so re-importing an overlapping file just overwrites
          // the affected days via `put`, with no separate dedup step needed.
          db.createObjectStore("temperatures", { keyPath: "date" });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    return dbPromise;
  }

  /** Opens a transaction on `storeName` and returns its object store, once the DB is ready. */
  async function tx(storeName, mode) {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  /** Wraps a raw IDBRequest in a Promise so call sites can use async/await. */
  function promisifyRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** RFC4122 v4 UUID, with a manual fallback for browsers lacking crypto.randomUUID. */
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // --- Entries ---

  /**
   * Inserts a new entry, filling in any field the caller omitted (id,
   * timestamp) with sensible defaults.
   * @param {{id?: string, timestamp?: string, tags?: string[], conditions?: string[], severity?: number|null, note?: string}} entry
   * @returns {Promise<object>} the full record as stored
   */
  async function addEntry(entry) {
    const record = {
      id: entry.id || uuid(),
      timestamp: entry.timestamp || new Date().toISOString(),
      tags: entry.tags || [],
      conditions: entry.conditions || [],
      severity: entry.severity ?? null,
      note: entry.note || "",
    };
    const store = await tx("entries", "readwrite");
    await promisifyRequest(store.add(record));
    return record;
  }

  /** Overwrites an existing entry by id (the record must already carry its `id`). */
  async function updateEntry(entry) {
    const store = await tx("entries", "readwrite");
    await promisifyRequest(store.put(entry));
    return entry;
  }

  async function deleteEntry(id) {
    const store = await tx("entries", "readwrite");
    await promisifyRequest(store.delete(id));
  }

  /** Deletes every entry. Used only by Import's "Replace All" mode - tags/conditions are untouched. */
  async function clearAllEntries() {
    const store = await tx("entries", "readwrite");
    await promisifyRequest(store.clear());
  }

  async function getEntry(id) {
    const store = await tx("entries", "readonly");
    return promisifyRequest(store.get(id));
  }

  async function getAllEntries() {
    const store = await tx("entries", "readonly");
    return promisifyRequest(store.getAll());
  }

  // --- Tags ---

  /**
   * Ensures a tag with this name exists, creating it if it doesn't.
   * `firstUsed` is what lets the Trends view clip a tag's chart to when it
   * actually started being tracked - so `occurredAt` should be the
   * timestamp of the entry that's using this tag, not necessarily "now".
   * If the tag already exists but `occurredAt` predates its `firstUsed`
   * (e.g. a backdated entry, or an older entry from an import), `firstUsed`
   * is corrected backwards to match; it's never pushed forward.
   * @param {string} name
   * @param {string} [occurredAt] - ISO timestamp of the entry using this tag; defaults to now
   * @returns {Promise<object|null>} the tag record, or null for a blank name
   */
  async function touchTag(name, occurredAt = new Date().toISOString()) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const store = await tx("tags", "readwrite");
    const existing = await promisifyRequest(store.get(trimmed));
    if (!existing) {
      const record = { name: trimmed, firstUsed: occurredAt, color: null };
      await promisifyRequest(store.add(record));
      return record;
    }
    if (new Date(occurredAt) < new Date(existing.firstUsed)) {
      const corrected = { ...existing, firstUsed: occurredAt };
      await promisifyRequest(store.put(corrected));
      return corrected;
    }
    return existing;
  }

  async function getAllTags() {
    const store = await tx("tags", "readonly");
    return promisifyRequest(store.getAll());
  }

  /**
   * Merges an imported tag record (from a JSON backup) into the local store.
   * Unlike touchTag, this takes a full record (its own `firstUsed`/`color`)
   * rather than inferring one from a single entry - used when restoring or
   * combining backups, where the incoming record already carries its true
   * history. The earlier of the two `firstUsed` dates always wins.
   * @param {{name: string, firstUsed?: string, color?: string|null}} record
   */
  async function mergeTagRecord(record) {
    const trimmed = (record.name || "").trim();
    if (!trimmed) return null;
    const store = await tx("tags", "readwrite");
    const existing = await promisifyRequest(store.get(trimmed));
    const incomingFirstUsed = record.firstUsed || new Date().toISOString();

    if (!existing) {
      const toStore = { name: trimmed, firstUsed: incomingFirstUsed, color: record.color || null };
      await promisifyRequest(store.add(toStore));
      return toStore;
    }
    if (new Date(incomingFirstUsed) < new Date(existing.firstUsed)) {
      const merged = { ...existing, firstUsed: incomingFirstUsed, color: existing.color || record.color || null };
      await promisifyRequest(store.put(merged));
      return merged;
    }
    return existing;
  }

  /**
   * Renames a tag and rewrites every entry that references it, in a single
   * atomic transaction spanning both the `tags` and `entries` stores (tags
   * are keyed by name, so a rename is really "create under the new name,
   * delete the old one, then repoint every entry" - this must not partially
   * apply). Uses the `tags` multiEntry index on `entries` so it only touches
   * entries that actually reference this tag, not every entry.
   * @param {string} oldName
   * @param {string} newName
   * @returns {Promise<object>} the renamed tag record
   * @throws if `oldName` doesn't exist, or `newName` is blank/already taken
   */
  async function renameTag(oldName, newName) {
    const trimmedNew = (newName || "").trim();
    if (!trimmedNew) throw new Error("New tag name can't be blank.");
    if (trimmedNew === oldName) return getAllTags().then((tags) => tags.find((t) => t.name === oldName));

    const db = await open();
    const transaction = db.transaction(["tags", "entries"], "readwrite");
    const tagStore = transaction.objectStore("tags");
    const entryStore = transaction.objectStore("entries");

    const existingOld = await promisifyRequest(tagStore.get(oldName));
    if (!existingOld) throw new Error(`Tag "${oldName}" not found.`);

    const existingNew = await promisifyRequest(tagStore.get(trimmedNew));
    if (existingNew) throw new Error(`"${trimmedNew}" is already a tag.`);

    const renamed = { ...existingOld, name: trimmedNew };
    await promisifyRequest(tagStore.add(renamed));
    await promisifyRequest(tagStore.delete(oldName));

    const affectedEntries = await promisifyRequest(entryStore.index("tags").getAll(oldName));
    for (const entry of affectedEntries) {
      const updated = { ...entry, tags: entry.tags.map((t) => (t === oldName ? trimmedNew : t)) };
      await promisifyRequest(entryStore.put(updated));
    }

    return renamed;
  }

  // --- Conditions ---

  /** Same idempotent create-if-missing pattern as touchTag, for the condition list. */
  async function touchCondition(name, occurredAt = new Date().toISOString()) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const store = await tx("conditions", "readwrite");
    const existing = await promisifyRequest(store.get(trimmed));
    if (!existing) {
      const record = { name: trimmed, createdAt: occurredAt };
      await promisifyRequest(store.add(record));
      return record;
    }
    if (new Date(occurredAt) < new Date(existing.createdAt)) {
      const corrected = { ...existing, createdAt: occurredAt };
      await promisifyRequest(store.put(corrected));
      return corrected;
    }
    return existing;
  }

  async function getAllConditions() {
    const store = await tx("conditions", "readonly");
    return promisifyRequest(store.getAll());
  }

  /** Same merge-preferring-earliest-date pattern as mergeTagRecord, for conditions. */
  async function mergeConditionRecord(record) {
    const trimmed = (record.name || "").trim();
    if (!trimmed) return null;
    const store = await tx("conditions", "readwrite");
    const existing = await promisifyRequest(store.get(trimmed));
    const incomingCreatedAt = record.createdAt || new Date().toISOString();

    if (!existing) {
      const toStore = { name: trimmed, createdAt: incomingCreatedAt };
      await promisifyRequest(store.add(toStore));
      return toStore;
    }
    if (new Date(incomingCreatedAt) < new Date(existing.createdAt)) {
      const merged = { ...existing, createdAt: incomingCreatedAt };
      await promisifyRequest(store.put(merged));
      return merged;
    }
    return existing;
  }

  // --- Factors (a separate, simpler log for non-symptom things like period/heat/medication changes) ---

  /** Same idempotent create-if-missing pattern as touchTag/touchCondition, for the factor lookup list. */
  async function touchFactor(name, occurredAt = new Date().toISOString()) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const store = await tx("factors", "readwrite");
    const existing = await promisifyRequest(store.get(trimmed));
    if (!existing) {
      const record = { name: trimmed, firstUsed: occurredAt };
      await promisifyRequest(store.add(record));
      return record;
    }
    if (new Date(occurredAt) < new Date(existing.firstUsed)) {
      const corrected = { ...existing, firstUsed: occurredAt };
      await promisifyRequest(store.put(corrected));
      return corrected;
    }
    return existing;
  }

  async function getAllFactors() {
    const store = await tx("factors", "readonly");
    return promisifyRequest(store.getAll());
  }

  /**
   * Logs a single factor occurrence. Unlike `entries`, a factor entry always
   * has exactly one `name` and no severity/tags/conditions - a multi-day
   * period is logged as one entry per day it's active, not a date range.
   * @param {{id?: string, timestamp?: string, name: string, note?: string}} entry
   */
  async function addFactorEntry(entry) {
    const record = {
      id: entry.id || uuid(),
      timestamp: entry.timestamp || new Date().toISOString(),
      name: entry.name,
      note: entry.note || "",
    };
    const store = await tx("factorEntries", "readwrite");
    await promisifyRequest(store.add(record));
    return record;
  }

  async function deleteFactorEntry(id) {
    const store = await tx("factorEntries", "readwrite");
    await promisifyRequest(store.delete(id));
  }

  async function getAllFactorEntries() {
    const store = await tx("factorEntries", "readonly");
    return promisifyRequest(store.getAll());
  }

  /** Inserts `record` if missing, or corrects `dateField` backward if `incomingDate` predates the stored one. */
  async function upsertEarliest(store, name, dateField, incomingDate, extraDefaults) {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    const existing = await promisifyRequest(store.get(trimmed));
    if (!existing) {
      await promisifyRequest(store.add({ name: trimmed, [dateField]: incomingDate, ...extraDefaults }));
      return;
    }
    if (new Date(incomingDate) < new Date(existing[dateField])) {
      await promisifyRequest(store.put({ ...existing, [dateField]: incomingDate }));
    }
  }

  /**
   * Performs a full structured import (Data tab's "Restore a backup") in a
   * single transaction spanning entries/tags/conditions/factors/
   * factorEntries/temperatures, instead of the hundreds of separate
   * transactions a naive per-record loop would open - that overhead is what
   * made large imports feel like they'd hung even though they'd eventually
   * finish.
   * @param {object} opts
   * @param {object[]} opts.entries - entry records to upsert (each already has an id)
   * @param {object[]} opts.tagRecords - explicit tag metadata from the file, if any (may be empty)
   * @param {object[]} opts.conditionRecords - explicit condition metadata from the file, if any (may be empty)
   * @param {Map<string,string>} opts.tagFirstUse - tag name -> earliest ISO timestamp, derived from the entries
   * @param {Map<string,string>} opts.conditionFirstUse - condition name -> earliest ISO timestamp, derived from the entries
   * @param {boolean} opts.clearExistingEntries - true for "Replace All" - also clears factorEntries
   *   (both are "logged data"), but never tags/conditions/factors (lookup lists) or temperatures
   * @param {object[]} [opts.factorEntryRecords] - factor entries to upsert (each already has an id, so
   *   re-importing the same backup in Append mode overwrites in place rather than duplicating)
   * @param {object[]} [opts.factorRecords] - explicit factor metadata from the file, if any (may be empty)
   * @param {Map<string,string>} [opts.factorFirstUse] - factor name -> earliest ISO timestamp, derived from factorEntryRecords
   * @param {object[]} [opts.temperatureRecords] - {date, value} readings, always upserted regardless of mode
   */
  async function bulkImportEntries({
    entries,
    tagRecords,
    conditionRecords,
    tagFirstUse,
    conditionFirstUse,
    clearExistingEntries,
    factorEntryRecords = [],
    factorRecords = [],
    factorFirstUse = new Map(),
    temperatureRecords = [],
  }) {
    const db = await open();
    const transaction = db.transaction(["entries", "tags", "conditions", "factors", "factorEntries", "temperatures"], "readwrite");
    const entryStore = transaction.objectStore("entries");
    const tagStore = transaction.objectStore("tags");
    const conditionStore = transaction.objectStore("conditions");
    const factorStore = transaction.objectStore("factors");
    const factorEntryStore = transaction.objectStore("factorEntries");
    const temperatureStore = transaction.objectStore("temperatures");

    for (const t of tagRecords) {
      await upsertEarliest(tagStore, t.name, "firstUsed", t.firstUsed || new Date().toISOString(), {
        color: t.color || null,
      });
    }
    for (const c of conditionRecords) {
      await upsertEarliest(conditionStore, c.name, "createdAt", c.createdAt || new Date().toISOString(), {});
    }
    for (const f of factorRecords) {
      await upsertEarliest(factorStore, f.name, "firstUsed", f.firstUsed || new Date().toISOString(), {});
    }

    if (clearExistingEntries) {
      await promisifyRequest(entryStore.clear());
      await promisifyRequest(factorEntryStore.clear());
    }

    for (const [name, occurredAt] of tagFirstUse) {
      await upsertEarliest(tagStore, name, "firstUsed", occurredAt, { color: null });
    }
    for (const [name, occurredAt] of conditionFirstUse) {
      await upsertEarliest(conditionStore, name, "createdAt", occurredAt, {});
    }
    for (const [name, occurredAt] of factorFirstUse) {
      await upsertEarliest(factorStore, name, "firstUsed", occurredAt, {});
    }

    for (const e of entries) {
      await promisifyRequest(entryStore.put(e));
    }
    for (const fe of factorEntryRecords) {
      await promisifyRequest(factorEntryStore.put(fe));
    }
    for (const t of temperatureRecords) {
      await promisifyRequest(temperatureStore.put(t));
    }
  }

  // --- Temperatures (imported daily readings) ---

  async function getAllTemperatures() {
    const store = await tx("temperatures", "readonly");
    return promisifyRequest(store.getAll());
  }

  /**
   * Imports a batch of daily temperature readings, and optionally logs
   * "Heatwave" factor entries for days above a threshold - in one
   * transaction, same reasoning as bulkImportEntries (a large file shouldn't
   * turn into hundreds of separate transactions).
   * @param {object} opts
   * @param {{date: string, value: number}[]} opts.temperatures - one per calendar day; `put` overwrites on re-import
   * @param {string[]} opts.heatwaveDates - ISO timestamps (already deduped
   *   against existing "Heatwave" factorEntries by the caller), ascending -
   *   each becomes a new factorEntries record
   */
  async function bulkImportTemperatures({ temperatures, heatwaveDates }) {
    const db = await open();
    const transaction = db.transaction(["temperatures", "factors", "factorEntries"], "readwrite");
    const tempStore = transaction.objectStore("temperatures");
    const factorStore = transaction.objectStore("factors");
    const factorEntryStore = transaction.objectStore("factorEntries");

    for (const t of temperatures) {
      await promisifyRequest(tempStore.put(t));
    }

    if (heatwaveDates.length > 0) {
      await upsertEarliest(factorStore, "Heatwave", "firstUsed", heatwaveDates[0], {});
    }
    for (const timestamp of heatwaveDates) {
      await promisifyRequest(
        factorEntryStore.add({ id: uuid(), timestamp, name: "Heatwave", note: "Auto-flagged from imported temperature data" })
      );
    }
  }

  /**
   * Bulk-adds factor entries from the Data tab's "Import Factor Log", in one
   * transaction (same reasoning as bulkImportEntries/bulkImportTemperatures).
   * Unlike bulkImportTemperatures's single "Heatwave" case, an import here
   * can span several distinct factor names at once, so firstUsed is upserted
   * per name using the earliest timestamp for that name within this batch.
   * @param {{name: string, timestamp: string}[]} entries - in Append mode
   *   (clearExisting: false), already deduped against existing factorEntries
   *   by the caller (same day+name = skip)
   * @param {object} [opts]
   * @param {boolean} [opts.clearExisting] - true for "Replace All": clears
   *   every existing factorEntries record first (never `factors` - the
   *   lookup list of names is never cleared, same as tags/conditions)
   */
  async function bulkImportFactorEntries(entries, { clearExisting = false } = {}) {
    const db = await open();
    const transaction = db.transaction(["factors", "factorEntries"], "readwrite");
    const factorStore = transaction.objectStore("factors");
    const factorEntryStore = transaction.objectStore("factorEntries");

    const earliestByName = new Map();
    for (const e of entries) {
      const current = earliestByName.get(e.name);
      if (!current || new Date(e.timestamp) < new Date(current)) earliestByName.set(e.name, e.timestamp);
    }
    for (const [name, earliest] of earliestByName) {
      await upsertEarliest(factorStore, name, "firstUsed", earliest, {});
    }

    if (clearExisting) {
      await promisifyRequest(factorEntryStore.clear());
    }

    for (const e of entries) {
      await promisifyRequest(factorEntryStore.add({ id: uuid(), timestamp: e.timestamp, name: e.name, note: "" }));
    }
  }

  return {
    open,
    uuid,
    addEntry,
    updateEntry,
    deleteEntry,
    clearAllEntries,
    bulkImportEntries,
    getEntry,
    getAllEntries,
    touchTag,
    getAllTags,
    mergeTagRecord,
    renameTag,
    touchCondition,
    getAllConditions,
    mergeConditionRecord,
    touchFactor,
    getAllFactors,
    addFactorEntry,
    deleteFactorEntry,
    getAllFactorEntries,
    getAllTemperatures,
    bulkImportTemperatures,
    bulkImportFactorEntries,
  };
})();

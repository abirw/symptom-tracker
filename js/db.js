/**
 * Hand-rolled IndexedDB wrapper — no external dependency. Exposes seven
 * object stores: `entries` (the logged symptom entries), `tags`, `conditions`,
 * and `triggers` (all "grow as you go" lookup lists per SPEC.md - triggers
 * are a separate taxonomy from tags, since a cause like "bright light" is
 * conceptually different from a symptom), `factorEntries`/`factors` — a
 * parallel, simpler log for things like period, heatwaves, or medication
 * changes that aren't symptoms themselves but help explain symptom patterns
 * (deliberately kept separate from `entries`) — and `temperatures`, one
 * value per calendar day, imported from a text file rather than logged by
 * hand. Every public method returns a Promise; there is no in-memory cache
 * here, callers (the view modules) hold their own copies for the duration
 * of a render.
 */
const DB = (() => {
  const DB_NAME = "symptom-tracker";
  const DB_VERSION = 6;

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
        // Any migration that needs to rewrite existing entry records pushes a
        // transform here instead of opening its own cursor - two independent
        // cursors iterating/updating the same store within one transaction
        // race each other (whichever's `cursor.update()` lands last wins,
        // silently discarding the other's fix), so every entries-rewriting
        // migration is applied together in a single pass at the end.
        const entryTransforms = [];

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

          entryTransforms.push((record) => {
            if (Array.isArray(record.conditions)) return false;
            record.conditions = record.condition ? [record.condition] : [];
            delete record.condition;
            return true;
          });
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

        if (event.oldVersion < 5) {
          // v4 -> v5: adds the trigger-tags lookup list (a separate taxonomy
          // from `tags` - causes, not symptoms) alongside new optional entry
          // fields (duration, awareness level, time of day, trigger tags)
          // that are just plain fields on the existing `entries` records, so
          // they need no schema change of their own.
          db.createObjectStore("triggers", { keyPath: "name" });
        }

        if (event.oldVersion < 6) {
          // v5 -> v6: backfills occurrenceCount = 1 onto every existing entry
          // that doesn't already have one set, so it's an explicit, visible
          // field in the JSON export for every entry - not just ones created
          // or edited after this feature shipped. addEntry/updateEntry
          // already default it for anything written from here on.
          entryTransforms.push((record) => {
            if (record.occurrenceCount) return false;
            record.occurrenceCount = 1;
            return true;
          });
        }

        if (entryTransforms.length > 0) {
          const entries = transaction.objectStore("entries");
          entries.openCursor().onsuccess = (cursorEvent) => {
            const cursor = cursorEvent.target.result;
            if (!cursor) return;
            const record = cursor.value;
            const changed = entryTransforms.reduce((any, transform) => transform(record) || any, false);
            if (changed) cursor.update(record);
            cursor.continue();
          };
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
      occurrenceCount: entry.occurrenceCount || 1,
      durationMinutes: entry.durationMinutes ?? null,
      durationEstimated: entry.durationEstimated ?? false,
      awarenessLevel: entry.awarenessLevel ?? null,
      timeOfDay: entry.timeOfDay ?? null,
      triggerTags: entry.triggerTags || [],
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

  /**
   * Renames a condition and rewrites every entry that references it, in a
   * single atomic transaction spanning both the `conditions` and `entries`
   * stores - verbatim mirror of renameTag, adjusted for the `conditions`
   * field/index instead of `tags`.
   * @param {string} oldName
   * @param {string} newName
   * @returns {Promise<object>} the renamed condition record
   * @throws if `oldName` doesn't exist, or `newName` is blank/already taken
   */
  async function renameCondition(oldName, newName) {
    const trimmedNew = (newName || "").trim();
    if (!trimmedNew) throw new Error("New condition name can't be blank.");
    if (trimmedNew === oldName) return getAllConditions().then((conditions) => conditions.find((c) => c.name === oldName));

    const db = await open();
    const transaction = db.transaction(["conditions", "entries"], "readwrite");
    const conditionStore = transaction.objectStore("conditions");
    const entryStore = transaction.objectStore("entries");

    const existingOld = await promisifyRequest(conditionStore.get(oldName));
    if (!existingOld) throw new Error(`Condition "${oldName}" not found.`);

    const existingNew = await promisifyRequest(conditionStore.get(trimmedNew));
    if (existingNew) throw new Error(`"${trimmedNew}" is already a condition.`);

    const renamed = { ...existingOld, name: trimmedNew };
    await promisifyRequest(conditionStore.add(renamed));
    await promisifyRequest(conditionStore.delete(oldName));

    const affectedEntries = await promisifyRequest(entryStore.index("conditions").getAll(oldName));
    for (const entry of affectedEntries) {
      const updated = { ...entry, conditions: entry.conditions.map((c) => (c === oldName ? trimmedNew : c)) };
      await promisifyRequest(entryStore.put(updated));
    }

    return renamed;
  }

  /**
   * Deletes a condition from the lookup list and strips it from every entry
   * that referenced it (rather than leaving entries pointing at a name that
   * no longer exists anywhere) - same atomic two-store transaction shape as
   * renameCondition, but removing instead of replacing.
   * @param {string} name
   * @throws if `name` doesn't exist
   */
  async function deleteCondition(name) {
    const db = await open();
    const transaction = db.transaction(["conditions", "entries"], "readwrite");
    const conditionStore = transaction.objectStore("conditions");
    const entryStore = transaction.objectStore("entries");

    const existing = await promisifyRequest(conditionStore.get(name));
    if (!existing) throw new Error(`Condition "${name}" not found.`);

    await promisifyRequest(conditionStore.delete(name));

    const affectedEntries = await promisifyRequest(entryStore.index("conditions").getAll(name));
    for (const entry of affectedEntries) {
      const updated = { ...entry, conditions: entry.conditions.filter((c) => c !== name) };
      await promisifyRequest(entryStore.put(updated));
    }
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
   * Sets how a factor should render on charts: "bar" (default - a count per
   * bucket, like Trends' existing Factor Activity chart), "line" (a vertical
   * marker at each occurrence, e.g. a medication change), or "span" (a
   * shaded date range across a recurring run of days, e.g. a period). A new
   * optional field on the existing `factors` record - no schema change.
   * @param {string} name
   * @param {"bar"|"line"|"span"} displayType
   */
  async function setFactorDisplayType(name, displayType) {
    const store = await tx("factors", "readwrite");
    const existing = await promisifyRequest(store.get(name));
    if (!existing) return null;
    const updated = { ...existing, displayType };
    await promisifyRequest(store.put(updated));
    return updated;
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

  // --- Triggers (a separate "grow as you go" taxonomy from tags - causes, not symptoms) ---

  /** Same idempotent create-if-missing pattern as touchFactor, for the trigger lookup list. */
  async function touchTrigger(name, occurredAt = new Date().toISOString()) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const store = await tx("triggers", "readwrite");
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

  async function getAllTriggers() {
    const store = await tx("triggers", "readonly");
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
      // Defaults occurrenceCount for a restored entry the same way addEntry
      // does for a newly-logged one - covers both an older backup (exported
      // before this field existed) and a fresh install's v5->v6 migration
      // never having a chance to run on entries that arrive via import
      // instead of already being in the store when that migration runs.
      await promisifyRequest(entryStore.put({ ...e, occurrenceCount: e.occurrenceCount || 1 }));
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
    renameCondition,
    deleteCondition,
    touchFactor,
    getAllFactors,
    setFactorDisplayType,
    addFactorEntry,
    deleteFactorEntry,
    getAllFactorEntries,
    touchTrigger,
    getAllTriggers,
    getAllTemperatures,
    bulkImportTemperatures,
    bulkImportFactorEntries,
  };
})();

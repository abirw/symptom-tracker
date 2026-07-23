/**
 * Hand-rolled IndexedDB wrapper — no external dependency. Exposes three
 * object stores: `entries` (the logged symptom entries), `tags`, and
 * `conditions` (both "grow as you go" lookup lists per SPEC.md). Every
 * public method returns a Promise; there is no in-memory cache here, callers
 * (the view modules) hold their own copies for the duration of a render.
 */
const DB = (() => {
  const DB_NAME = "symptom-tracker";
  const DB_VERSION = 2;

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

  return {
    open,
    uuid,
    addEntry,
    updateEntry,
    deleteEntry,
    getEntry,
    getAllEntries,
    touchTag,
    getAllTags,
    mergeTagRecord,
    renameTag,
    touchCondition,
    getAllConditions,
    mergeConditionRecord,
  };
})();

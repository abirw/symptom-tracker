/**
 * Hand-rolled IndexedDB wrapper — no external dependency. Exposes three
 * object stores: `entries` (the logged symptom entries), `tags`, and
 * `conditions` (both "grow as you go" lookup lists per SPEC.md). Every
 * public method returns a Promise; there is no in-memory cache here, callers
 * (the view modules) hold their own copies for the duration of a render.
 */
const DB = (() => {
  const DB_NAME = "symptom-tracker";
  const DB_VERSION = 1;

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

        if (!db.objectStoreNames.contains("entries")) {
          const entries = db.createObjectStore("entries", { keyPath: "id" });
          entries.createIndex("timestamp", "timestamp");
          entries.createIndex("tags", "tags", { multiEntry: true });
          entries.createIndex("condition", "condition");
        }

        if (!db.objectStoreNames.contains("tags")) {
          db.createObjectStore("tags", { keyPath: "name" });
        }

        if (!db.objectStoreNames.contains("conditions")) {
          db.createObjectStore("conditions", { keyPath: "name" });
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
   * @param {{id?: string, timestamp?: string, tags?: string[], condition?: string|null, severity?: number|null, note?: string}} entry
   * @returns {Promise<object>} the full record as stored
   */
  async function addEntry(entry) {
    const record = {
      id: entry.id || uuid(),
      timestamp: entry.timestamp || new Date().toISOString(),
      tags: entry.tags || [],
      condition: entry.condition || null,
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
   * Ensures a tag with this name exists, creating it (with `firstUsed` set to
   * now) if it doesn't. `firstUsed` is what lets the Trends view clip a tag's
   * chart to when it actually started being tracked, so re-touching an
   * existing tag must NOT overwrite that date.
   * @param {string} name
   * @returns {Promise<object|null>} the tag record, or null for a blank name
   */
  async function touchTag(name) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const store = await tx("tags", "readwrite");
    const existing = await promisifyRequest(store.get(trimmed));
    if (existing) return existing;
    const record = { name: trimmed, firstUsed: new Date().toISOString(), color: null };
    await promisifyRequest(store.add(record));
    return record;
  }

  async function getAllTags() {
    const store = await tx("tags", "readonly");
    return promisifyRequest(store.getAll());
  }

  // --- Conditions ---

  /** Same idempotent create-if-missing pattern as touchTag, for the condition list. */
  async function touchCondition(name) {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const store = await tx("conditions", "readwrite");
    const existing = await promisifyRequest(store.get(trimmed));
    if (existing) return existing;
    const record = { name: trimmed, createdAt: new Date().toISOString() };
    await promisifyRequest(store.add(record));
    return record;
  }

  async function getAllConditions() {
    const store = await tx("conditions", "readonly");
    return promisifyRequest(store.getAll());
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
    touchCondition,
    getAllConditions,
  };
})();

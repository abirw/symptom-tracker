/* Hand-rolled IndexedDB wrapper. No external dependencies. */

const DB = (() => {
  const DB_NAME = "symptom-tracker";
  const DB_VERSION = 1;

  let dbPromise = null;

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

  function tx(storeName, mode) {
    return open().then((db) => db.transaction(storeName, mode).objectStore(storeName));
  }

  function promisifyRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // --- Entries ---

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

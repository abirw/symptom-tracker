/**
 * Tiny persisted-preferences store, backed by localStorage (not IndexedDB -
 * these are UI preferences, not tracked health data, so a synchronous
 * key/value store is a better fit than another async DB round-trip).
 */
const Settings = (() => {
  const STORAGE_KEY = "symptom-tracker:settings";
  const DEFAULTS = {
    tagPickerMode: "classic", // "classic" | "smart"
    heatmapColorMode: "frequency", // "frequency" | "avgSeverity" | "maxSeverity"
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function save(values) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
    } catch {
      // Storage can be unavailable (e.g. some private-browsing modes) - a
      // setting failing to persist isn't worth surfacing an error over.
    }
  }

  function get(key) {
    return load()[key];
  }

  function set(key, value) {
    const values = load();
    values[key] = value;
    save(values);
  }

  return { get, set, DEFAULTS };
})();

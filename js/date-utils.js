/**
 * Tiny shared date helpers used by every screen that edits a
 * `datetime-local` input against a stored ISO timestamp (Log, Timeline's
 * edit modal, and the Import candidate editor).
 */
const DateUtils = (() => {
  /** ISO timestamp -> the local-time string a `datetime-local` input expects. */
  function toLocalInputValue(iso) {
    const d = new Date(iso);
    const offsetMs = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
  }

  /** `datetime-local`-formatted "now", for defaulting a fresh form. */
  function nowForInput() {
    return toLocalInputValue(new Date().toISOString());
  }

  return { toLocalInputValue, nowForInput };
})();

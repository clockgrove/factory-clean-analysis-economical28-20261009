const key = 'incident-explorer.triage.v1';
const severities = new Set(['critical', 'high', 'medium', 'low']);
const statuses = new Set(['open', 'in_progress', 'resolved']);
const fields = ['id', 'title', 'description', 'service', 'severity', 'status', 'openedAt', 'resolvedAt', 'team', 'region', 'tags'];
const text = value => typeof value === 'string';

export function validIncident(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && fields.every(field => Object.hasOwn(value, field))
    && /^INC-[0-9]{6}$/.test(value.id)
    && ['title', 'description', 'service', 'team', 'region'].every(field => text(value[field]))
    && severities.has(value.severity) && statuses.has(value.status)
    && text(value.openedAt) && Number.isFinite(Date.parse(value.openedAt))
    && (value.resolvedAt === null || text(value.resolvedAt) && Number.isFinite(Date.parse(value.resolvedAt)))
    && Array.isArray(value.tags) && value.tags.every(text);
}

function validEntry(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && validIncident(value.incident) && text(value.note);
}

export function loadTriage(storage) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return {entries: [], status: 'Browser storage is unavailable. Triage will last only for this visit unless storage becomes available.'};
  }
  if (raw === null) return {entries: [], status: ''};
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !Array.isArray(value.entries) || !value.entries.every(validEntry)
      || new Set(value.entries.map(entry => entry.incident.id)).size !== value.entries.length) {
      return {entries: [], status: 'Stored triage data is malformed. This visit still works; saving a change will replace it.'};
    }
    return {entries: value.entries.map(entry => ({incident: Object.fromEntries(fields.map(field => [field, field === 'tags' ? [...entry.incident.tags] : entry.incident[field]])), note: entry.note})), status: ''};
  } catch {
    return {entries: [], status: 'Stored triage data is malformed. This visit still works; saving a change will replace it.'};
  }
}

export function saveTriage(storage, entries) {
  try {
    storage.setItem(key, JSON.stringify({version: 1, entries}));
    return {ok: true, status: 'Triage saved in this browser.'};
  } catch {
    return {ok: false, status: 'Browser storage is unavailable. Triage remains usable for this visit but may not survive reload.'};
  }
}

export function addTriageEntry(entries, incident) {
  if (!validIncident(incident)) throw new TypeError('A complete canonical incident is required.');
  if (entries.some(entry => entry.incident.id === incident.id)) return entries;
  return [...entries, {incident: Object.fromEntries(fields.map(field => [field, field === 'tags' ? [...incident.tags] : incident[field]])), note: ''}];
}

export function updateTriageNote(entries, id, note) {
  if (!text(note)) throw new TypeError('A triage note must be plain text.');
  return entries.map(entry => entry.incident.id === id ? {...entry, note} : entry);
}

export function removeTriageEntry(entries, id) {
  return entries.filter(entry => entry.incident.id !== id);
}

export function triageStorageKey() { return key; }

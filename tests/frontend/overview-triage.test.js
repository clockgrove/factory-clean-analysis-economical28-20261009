import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, transition, overviewIdentity, overviewParams, announcement} from '../../public/state.js';
import {loadTriage, saveTriage, addTriageEntry, updateTriageNote, removeTriageEntry, triageStorageKey} from '../../public/triage.js';

const send = (state, type, payload = {}) => transition(state, {type, ...payload});
const incident = (id, title = `Incident ${id}`) => ({id, title, description: 'Plain text <script> & punctuation!', service: 'Billing', severity: 'high', status: 'open', openedAt: '2026-04-01T12:00:00.000Z', resolvedAt: null, team: 'Team A', region: 'AMER', tags: ['follow-up']});

test('overview results, failures and cleanup are owned by the current normalized filter selection', () => {
  let state = createState();
  state = send(state, 'overview:start'); const oldToken = state.overviewOp.token, oldIdentity = state.overviewOp.identity;
  state = send(state, 'intent', {patch: {q: 'new', service: ['Billing']}});
  state = send(state, 'overview:start'); const current = state, currentToken = state.overviewOp.token;
  for (const type of ['overview:success', 'overview:failure', 'overview:finish']) {
    assert.equal(send(state, type, {token: oldToken, identity: oldIdentity, data: {services: [{service: 'old'}]}, error: 'old failure'}), current);
  }
  state = send(state, 'overview:failure', {token: currentToken, identity: state.overviewOp.identity, error: 'Current overview failed'});
  assert.equal(announcement(state), 'Current overview failed');
  state = send(state, 'overview:start'); const retryToken = state.overviewOp.token, identity = state.overviewOp.identity;
  assert.equal(send(state, 'overview:finish', {token: currentToken, identity}), state);
  assert.equal(state.overviewOp.pending, true);
  const data = {services: [{service: 'Billing', total: 4, unresolved: 3, highSeverity: 2, averageResolutionHours: null}]};
  state = send(state, 'overview:success', {token: retryToken, identity, data});
  assert.equal(state.overview.data, data); assert.equal(state.overview.identity, identity);
  assert.equal(state.overviewOp.pending, false);
});

test('overview identity excludes sort and pagination, includes filters, and requests only filter parameters', () => {
  const filters = {q: 'billing', service: ['Search', 'Billing'], from: '2026-04-01', to: '2026-04-30'};
  const first = {...filters, page: 1, pageSize: 25, sort: 'openedAt', direction: 'desc'};
  const second = {...first, page: 7, pageSize: 50, sort: 'severity', direction: 'asc'};
  assert.equal(overviewIdentity(first), overviewIdentity(second));
  assert.notEqual(overviewIdentity(first), overviewIdentity({...first, q: 'other'}));
  assert.deepEqual([...overviewParams(second)], [['q', 'billing'], ['service', 'Billing'], ['service', 'Search'], ['from', '2026-04-01'], ['to', '2026-04-30']]);
  let state = send(createState(), 'result:start');
  state = send(state, 'result:success', {token: state.resultOp.token, data: {items: [], page: 1, totalPages: 2, total: 26}});
  state = send(state, 'overview:start');
  const token = state.overviewOp.token, identity = state.overviewOp.identity;
  state = send(state, 'overview:success', {token, identity, data: {services: []}});
  const overview = state.overview;
  state = send(state, 'overview:start'); const pendingToken = state.overviewOp.token;
  state = send(state, 'page', {delta: 1});
  assert.equal(state.intent.page, 2);
  assert.equal(state.overviewOp.token, pendingToken);
  assert.equal(state.overviewOp.pending, true);
  assert.equal(state.overview, overview);
});

test('triage persistence validates data, keeps ordered unique membership, edits plain text, and removes notes', () => {
  const memory = new Map();
  const storage = {getItem: name => memory.get(name) ?? null, setItem: (name, value) => memory.set(name, value)};
  let loaded = loadTriage(storage); assert.deepEqual(loaded.entries, []);
  let entries = addTriageEntry(loaded.entries, incident('INC-000001'));
  entries = addTriageEntry(entries, incident('INC-000002'));
  entries = updateTriageNote(entries, 'INC-000001', 'literal <b>markup</b> & punctuation: "yes"');
  const duplicate = addTriageEntry(entries, incident('INC-000001', 'A newer title'));
  assert.equal(duplicate, entries);
  assert.deepEqual(entries.map(entry => entry.incident.id), ['INC-000001', 'INC-000002']);
  assert.equal(entries[0].note, 'literal <b>markup</b> & punctuation: "yes"');
  assert.equal(saveTriage(storage, entries).ok, true);
  assert.equal(memory.has(triageStorageKey()), true);
  loaded = loadTriage(storage); assert.deepEqual(loaded.entries, entries);
  entries = removeTriageEntry(loaded.entries, 'INC-000001');
  assert.deepEqual(entries.map(entry => entry.incident.id), ['INC-000002']);
  assert.equal(saveTriage(storage, entries).ok, true);
  assert.equal(loadTriage(storage).entries[0].note, '');
});

test('malformed or unavailable storage is reported and memory remains usable when writes fail', () => {
  const malformed = {getItem: () => '{broken', setItem: () => assert.fail('load must not overwrite malformed data')};
  const result = loadTriage(malformed);
  assert.deepEqual(result.entries, []); assert.match(result.status, /malformed/);
  const unavailable = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }};
  const denied = loadTriage(unavailable); assert.match(denied.status, /unavailable/);
  const entries = addTriageEntry(denied.entries, incident('INC-000003'));
  const saved = saveTriage(unavailable, entries);
  assert.equal(saved.ok, false); assert.match(saved.status, /remains usable/);
  assert.equal(entries[0].incident.id, 'INC-000003');
});

test('opening triage detail keeps search snapshot ownership; close and reselection gate prior detail writers', () => {
  let state = send(createState(), 'result:start');
  state = send(state, 'result:success', {token: state.resultOp.token, data: {items: [], page: 1, totalPages: 1, total: 0}});
  const result = state.result, intent = state.intent;
  state = send(state, 'detail:select', {id: 'INC-000001'}); state = send(state, 'detail:start'); const old = state.detail.token;
  state = send(state, 'detail:success', {token: old, data: incident('INC-000001')});
  assert.equal(state.result, result); assert.equal(state.intent, intent);
  state = send(state, 'detail:close');
  for (const type of ['detail:success', 'detail:failure', 'detail:finish']) assert.equal(send(state, type, {token: old, data: incident('INC-000001'), error: 'late'}), state);
  state = send(state, 'detail:select', {id: 'INC-000002'}); state = send(state, 'detail:start');
  assert.equal(state.detail.id, 'INC-000002'); assert.equal(state.result, result); assert.equal(state.intent, intent);
});

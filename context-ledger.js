'use strict';

/*
 * Small local context ledger: knows what was sent, its digest, chat epoch and
 * whether an edit made it stale. It does not decide DONE and does not call a
 * model.
 */

const crypto = require('crypto');

function digest(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function create() {
  return {
    epoch: 0,
    items: {},
    sentItems: 0,
    promptBytes: 0,
    duplicateBytes: 0,
    staleItems: 0,
  };
}

function ensure(state) {
  if (!state.context || typeof state.context !== 'object') state.context = create();
  const c = state.context;
  c.items = c.items && typeof c.items === 'object' ? c.items : {};
  c.epoch = Number(c.epoch) || 0;
  for (const key of ['sentItems', 'promptBytes', 'duplicateBytes', 'staleItems']) {
    c[key] = Number(c[key]) || 0;
  }
  return c;
}

function record(state, id, type, text, turn) {
  const c = ensure(state);
  const d = digest(text);
  const bytes = Buffer.byteLength(String(text || ''));
  const prev = c.items[id];
  const duplicate = prev && prev.digest === d && prev.epoch === c.epoch;
  if (duplicate) c.duplicateBytes += bytes;
  else c.sentItems++;
  c.items[id] = {
    id,
    type,
    digest: d,
    bytes,
    epoch: c.epoch,
    lastSentTurn: turn,
    stale: false,
  };
  c.promptBytes += bytes;
  return c.items[id];
}

function invalidate(state, pathOrIds) {
  const c = ensure(state);
  const list = Array.isArray(pathOrIds) ? pathOrIds : [pathOrIds];
  let changed = 0;
  for (const item of Object.values(c.items)) {
    if (list.some((needle) => item.id === needle || item.id.startsWith(String(needle) + ':'))) {
      if (!item.stale) changed++;
      item.stale = true;
    }
  }
  c.staleItems += changed;
  return changed;
}

function newEpoch(state) {
  const c = ensure(state);
  c.epoch++;
  for (const item of Object.values(c.items)) {
    if (item.epoch !== c.epoch) item.stale = true;
  }
  return c.epoch;
}

function summary(state) {
  const c = ensure(state);
  return {
    epoch: c.epoch,
    items: Object.keys(c.items).length,
    sentItems: c.sentItems,
    promptBytes: c.promptBytes,
    duplicateBytes: c.duplicateBytes,
    staleItems: c.staleItems,
  };
}

module.exports = { create, ensure, record, invalidate, newEpoch, summary, digest };

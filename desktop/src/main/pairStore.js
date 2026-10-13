'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Persistent store for paired/trusted phones and last-used settings.
 * Simple JSON file in userData. Keys: trusted (map id->info), last (last connection).
 */
class PairStore {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'pairstore.json');
    this.data = { trusted: {}, last: null };
    this.load();
  }
  load() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* defaults */ }
    if (!this.data.trusted) this.data.trusted = {};
  }
  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch {}
  }
  trust(id, info = {}) { this.data.trusted[id] = { ...info, at: Date.now() }; this.save(); }
  isTrusted(id) { return !!this.data.trusted[id]; }
  untrust(id) { delete this.data.trusted[id]; this.save(); }
  trustedList() { return Object.entries(this.data.trusted).map(([id, v]) => ({ id, ...v })); }
  setLast(last) { this.data.last = last; this.save(); }
  getLast() { return this.data.last; }
}

module.exports = { PairStore };

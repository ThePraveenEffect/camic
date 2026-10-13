'use strict';
const { Bonjour } = require('bonjour-service');
const { EventEmitter } = require('events');
const { MDNS_TYPE } = require('./protocol');

/**
 * Browses for Camic phones advertising _camic._tcp on the LAN.
 * Emits 'device'({id,name,host,port,txt}) for each found/updated device,
 * and 'remove'(id) when one goes away.
 */
class Discovery extends EventEmitter {
  constructor() {
    super();
    this.bonjour = null;
    this.browsers = [];
    this.devices = new Map(); // id -> device
  }

  start() {
    this.stop();
    this.bonjour = new Bonjour();
    // bonjour-service expects the bare service name ("camic"), which it
    // expands to the "_camic._tcp" DNS-SD type. MDNS_TYPE is "_camic._tcp".
    const current = MDNS_TYPE.replace(/\._tcp$/, '').replace(/^_/, '');
    // Legacy fallback: phones still running the pre-rename APK advertise
    // "_cambridge._tcp" instead, which would otherwise make rescan never find
    // them. Browse both (deduped by device id) until every phone is updated.
    // Set CAMIC_NO_LEGACY_MDNS=1 to drop the fallback.
    const types = [current];
    if (process.env.CAMIC_NO_LEGACY_MDNS !== '1') {
      const legacy = 'cambridge';
      if (!types.includes(legacy)) types.push(legacy);
    }
    this.browsers = types.map((type) => {
      const browser = this.bonjour.find({ type });
      browser.on('up', (svc) => this.onUp(svc));
      browser.on('down', (svc) => this.onDown(svc));
      browser.on('error', (err) => console.error('[discovery] browse error:', err && err.message));
      console.log('[discovery] browsing for', type);
      return browser;
    });
  }

  onUp(svc) {
    const txt = svc.txt || {};
    const id = txt.id || `${svc.host}:${svc.port}`;
    // Prefer a real IPv4 address for the control connection; fall back to host.
    const addrs = svc.addresses || [];
    const ipv4 = addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    const dev = {
      id,
      name: txt.name || svc.name,
      host: ipv4 || svc.host,
      port: svc.port,
      txt,
    };
    this.devices.set(id, dev);
    console.log('[discovery] found', dev.name, dev.host + ':' + dev.port);
    this.emit('device', dev);
  }

  onDown(svc) {
    const txt = svc.txt || {};
    const id = txt.id || `${svc.host}:${svc.port}`;
    if (this.devices.delete(id)) this.emit('remove', id);
  }

  list() { return [...this.devices.values()]; }

  stop() {
    for (const b of this.browsers) { try { b && b.stop(); } catch {} }
    this.browsers = [];
    try { this.bonjour && this.bonjour.destroy(); } catch {}
    this.bonjour = null;
    this.devices.clear();
  }
}

module.exports = { Discovery };

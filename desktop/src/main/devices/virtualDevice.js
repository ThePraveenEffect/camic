'use strict';
const os = require('os');
const { LinuxVirtualDevice } = require('./linuxVirtualDevice');

/**
 * Returns the platform-appropriate virtual device implementation.
 * Windows path (windowsVirtualDevice.js) is wired in M3.
 */
function createVirtualDevice(opts = {}) {
  if (os.platform() === 'linux') return new LinuxVirtualDevice(opts);
  if (os.platform() === 'win32') {
    const { WindowsVirtualDevice } = require('./windowsVirtualDevice');
    return new WindowsVirtualDevice(opts);
  }
  throw new Error('Unsupported platform: ' + os.platform());
}

module.exports = { createVirtualDevice };

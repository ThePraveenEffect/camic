const { chmodSync, existsSync } = require('fs');
const path = require('path');

module.exports = async function (context) {
  const sandbox = path.join(context.appOutDir, 'chrome-sandbox');
  if (existsSync(sandbox)) {
    // Electron requires the SUID helper to be root:root 4755.
    // Building as non-root strips it; releases build in Docker anyway.
    chmodSync(sandbox, 0o4755);
  }
};

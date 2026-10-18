#!/bin/bash
# Electron's SUID sandbox helper must be root-owned with the setuid bit.
# Our particle builds don't run as root, so the file ships without it.
if [ -x /opt/Camic/chrome-sandbox ]; then
    chown root:root /opt/Camic/chrome-sandbox || true
    chmod 4755 /opt/Camic/chrome-sandbox || true
fi
exit 0

#!/usr/bin/env bash
# Camic Linux host one-time setup.
# Run with sudo:  sudo ./scripts/setup-linux-host.sh
# What it does:
#   1. Installs build deps + ffmpeg + pactl (pulseaudio-utils).
#   2. Builds & installs the v4l2loopback kernel module via DKMS (virtual webcam).
#   3. Loads the module and persists it across boots.
#   4. Opens the Camic firewall ports (TCP 4747 control, UDP 4748 media).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root:  sudo $0" >&2; exit 1
fi

KVER="$(uname -r)"
echo "==> kernel: $KVER"

echo "==> [1/4] installing packages"
dnf install -y \
  dkms kernel-devel-"$KVER" kernel-headers gcc make git \
  ffmpeg pulseaudio-utils v4l2loopback-utils 2>/dev/null \
  || dnf install -y dkms kernel-devel-"$KVER" kernel-headers gcc make git ffmpeg pulseaudio-utils

echo "==> [2/4] building v4l2loopback via DKMS"
V4L_SRC=/usr/src/v4l2loopback-1.0
if [[ ! -d "$V4L_SRC" ]]; then
  git clone --depth 1 https://github.com/umlaeute/v4l2loopback.git /tmp/v4l2loopback
  mkdir -p "$V4L_SRC"
  cp -r /tmp/v4l2loopback/* "$V4L_SRC"/
fi
if ! dkms status | grep -q v4l2loopback; then
  dkms add v4l2loopback/1.0 || true
  dkms build v4l2loopback/1.0
  dkms install v4l2loopback/1.0
else
  echo "    v4l2loopback already registered with DKMS"
fi

echo "==> [3/4] loading module + persist"
modprobe v4l2loopback devices=1 video_nr=10 card_label="Camic Camera" exclusive_caps=1
cat > /etc/modules-load.d/camic.conf << EOF
# Camic virtual webcam
v4l2loopback
EOF
cat > /etc/modprobe.d/camic-v4l2loopback.conf << EOF
options v4l2loopback devices=1 video_nr=10 card_label="Camic Camera" exclusive_caps=1
EOF
echo "    created /dev/video10 (Camic Camera)"

# Grant the invoking user access to the camera + mic device nodes.
SUDO_USER_NAME="${SUDO_USER:-$(logname 2>/dev/null || echo "")}"
if [[ -n "$SUDO_USER_NAME" && "$SUDO_USER_NAME" != "root" ]]; then
  echo "==> adding $SUDO_USER_NAME to video + audio groups"
  usermod -aG video,audio "$SUDO_USER_NAME" || true
  echo "    (log out and back in for group changes to apply)"
fi

echo "==> [4/4] firewall"
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port=4747/tcp
  firewall-cmd --permanent --add-port=4748/udp
  firewall-cmd --reload
  echo "    opened 4747/tcp + 4748/udp"
else
  echo "    firewalld not active — skipped (ensure the ports are reachable on your LAN)"
fi

echo
echo "Done. Virtual camera: $(ls /dev/video10 2>/dev/null || echo 'not found — reboot may be required')"
echo "Verify with:  v4l2-ctl --list-devices"
echo "You can now start the Camic desktop app (npm start in desktop/)."

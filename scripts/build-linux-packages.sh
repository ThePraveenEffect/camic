#!/usr/bin/env bash
# Build the native Linux installers (.deb for Ubuntu/Debian, .rpm for Fedora)
# from electron-builder's linux-unpacked output — without needing dpkg/fpm.
#
#   scripts/build-linux-packages.sh            # build both
#   scripts/build-linux-packages.sh deb        # only .deb
#   scripts/build-linux-packages.sh rpm        # only .rpm
#
# Outputs land in dist/:  camic-<ver>-amd64.deb  and  camic-<ver>.x86_64.rpm
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/desktop"
UNPACKED="$APP_DIR/release/linux-unpacked"
OUT="$ROOT/dist"
VERSION="$(node -p "require('$APP_DIR/package.json').version")"
ARCH_DEB="amd64"
ARCH_RPM="x86_64"
MAINTAINER="Camic <maintainers@camic.app>"
HOMEPAGE="https://github.com/ThePraveenEffect/camic"
SUMMARY="Wireless webcam + mic from your phone over Wi-Fi"

WHAT="${1:-all}"
mkdir -p "$OUT"

[ -x "$UNPACKED/camic-desktop" ] || {
  echo "error: $UNPACKED not found — run: cd desktop && npx electron-builder --linux dir" >&2
  exit 1
}

# Shared payload staged once: /opt/camic + /usr/bin/camic + desktop entry + icons.
stage_payload() {
  local dest="$1"
  rm -rf "$dest"
  mkdir -p "$dest/opt/camic" "$dest/usr/bin" "$dest/usr/share/applications"
  cp -a "$UNPACKED/." "$dest/opt/camic/"

  # Electron's sandbox helper must be setuid root for the renderer sandbox to
  # work. Mode is recorded in the tarball / buildroot; ownership is normalised
  # by `tar --owner=0` (deb) and %defattr (rpm).
  if [ -f "$dest/opt/camic/chrome-sandbox" ]; then
    chmod 4755 "$dest/opt/camic/chrome-sandbox"
  fi

  cat > "$dest/usr/bin/camic" <<'WRAP'
#!/bin/sh
# Camic launcher — the app lives in /opt/camic.
exec /opt/camic/camic-desktop "$@"
WRAP
  chmod 0755 "$dest/usr/bin/camic"

  cat > "$dest/usr/share/applications/camic.desktop" <<'DESK'
[Desktop Entry]
Type=Application
Version=1.0
Name=Camic
GenericName=Wireless Webcam
Comment=Use your phone camera and mic as a wireless webcam over Wi-Fi
Exec=/usr/bin/camic %U
Icon=camic
Terminal=false
Categories=AudioVideo;Video;Network;
Keywords=webcam;camera;phone;stream;wireless;obs;zoom;meet;
StartupWMClass=Camic
StartupNotify=true
DESK

  local size
  for size in 16 24 32 48 64 128 256 512; do
    local src="$APP_DIR/build/icons/${size}x${size}.png"
    if [ -f "$src" ]; then
      mkdir -p "$dest/usr/share/icons/hicolor/${size}x${size}/apps"
      install -m 0644 "$src" "$dest/usr/share/icons/hicolor/${size}x${size}/apps/camic.png"
    fi
  done
}

build_deb() {
  local work="$APP_DIR/.pkg/deb"
  rm -rf "$work"
  local payload="$work/payload" ctrl="$work/control" data="$work/data.tar.gz" ctl="$work/control.tar.gz"

  stage_payload "$payload"
  mkdir -p "$ctrl"

  local installed_kb
  installed_kb=$(du -sk "$payload" | cut -f1)

  cat > "$ctrl/control" <<CTRL
Package: camic
Version: $VERSION
Architecture: $ARCH_DEB
Maintainer: $MAINTAINER
Installed-Size: $installed_kb
Section: video
Priority: optional
Homepage: $HOMEPAGE
Depends: libc6, libgtk-3-0 | libgtk-4-1, libnss3, libgbm1, libasound2t64 | libasound2, libxkbcommon0, libdrm2, libxcomposite1, libxdamage1, libxrandr2, libatspi2.0-0, libcups2t64 | libcups2, libx11-6, libxext6, libxfixes3, libpango-1.0-0
Recommends: v4l2loopback-dkms | v4l2loopback-utils
Description: $SUMMARY
 Camic turns an Android phone into a wireless webcam and microphone for your
 computer. The phone streams H.264 video and AAC audio over the local Wi-Fi
 network, and the desktop exposes it as a real virtual camera (v4l2loopback)
 and microphone (PipeWire/PulseAudio), so Zoom, Teams, OBS and browsers use it
 natively.
 .
 Devices are discovered automatically over mDNS and protected by a 6-digit
 pairing PIN.
CTRL

  cat > "$ctrl/postinst" <<'POST'
#!/bin/sh
set -e
case "$1" in
  configure)
    # Electron's sandbox helper must be setuid root.
    if [ -f /opt/camic/chrome-sandbox ]; then
      chown root:root /opt/camic/chrome-sandbox
      chmod 4755 /opt/camic/chrome-sandbox
    fi
    command -v update-desktop-database >/dev/null 2>&1 && \
      update-desktop-database -q /usr/share/applications || true
    command -v gtk-update-icon-cache >/dev/null 2>&1 && \
      gtk-update-icon-cache -q /usr/share/icons/hicolor || true
    ;;
esac
exit 0
POST
  chmod 0755 "$ctrl/postinst"

  cat > "$ctrl/postrm" <<'POST'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database -q /usr/share/applications || true
exit 0
POST
  chmod 0755 "$ctrl/postrm"

  # data.tar.gz : the staged tree as ./-prefixed paths
  tar -czf "$data" --owner=0 --group=0 --numeric-owner -C "$payload" .
  # control.tar.gz : ./control, ./postinst, ./postrm
  tar -czf "$ctl" -C "$ctrl" .

  printf '2.0\n' > "$work/debian-binary"

  local deb="$OUT/camic-$VERSION-$ARCH_DEB.deb"
  rm -f "$deb"
  ( cd "$work" && ar rc "$deb" debian-binary control.tar.gz data.tar.gz )

  echo "built: $deb ($(du -h "$deb" | cut -f1))"
}

build_rpm() {
  local top="$APP_DIR/.pkg/rpm"
  rm -rf "$top"
  mkdir -p "$top"/{SPECS,SRPMS,RPMS,BUILD,BUILDROOT,SRPMS}

  local spec="$top/SPECS/camic.spec"
  cat > "$spec" <<SPEC
Name:           camic
Version:        $VERSION
Release:        1%{?dist}
Summary:        $SUMMARY
License:        MIT
URL:            $HOMEPAGE
Vendor:         Camic
BuildArch:      $ARCH_RPM
AutoReqProv:    no
Requires:       gtk3, nss, alsa-lib, libxkbcommon, mesa-libgbm, cups-libs, libX11, libXcomposite, libXdamage, libXrandr, at-spi2-atk
Recommends:     v4l2loopback-dkms

%description
Camic turns an Android phone into a wireless webcam and microphone for your
computer. The phone streams H.264 video and AAC audio over the local Wi-Fi
network, and the desktop exposes it as a real virtual camera (v4l2loopback)
and microphone (PipeWire/PulseAudio), so Zoom, Teams, OBS and browsers use it
natively.

Devices are discovered automatically over mDNS and protected by a 6-digit
pairing PIN.

%prep
:

%build
:

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/opt %{buildroot}/usr/bin %{buildroot}/usr/share/applications
cp -a $APP_DIR/release/linux-unpacked %{buildroot}/opt/camic
cat > %{buildroot}/usr/bin/camic <<'WRAP'
#!/bin/sh
exec /opt/camic/camic-desktop "\$@"
WRAP
chmod 0755 %{buildroot}/usr/bin/camic
chmod 4755 %{buildroot}/opt/camic/chrome-sandbox
cat > %{buildroot}/usr/share/applications/camic.desktop <<'DESK'
[Desktop Entry]
Type=Application
Version=1.0
Name=Camic
GenericName=Wireless Webcam
Comment=Use your phone camera and mic as a wireless webcam over Wi-Fi
Exec=/usr/bin/camic %U
Icon=camic
Terminal=false
Categories=AudioVideo;Video;Network;
Keywords=webcam;camera;phone;stream;wireless;obs;zoom;meet;
StartupWMClass=Camic
StartupNotify=true
DESK
for s in 16 24 32 48 64 128 256 512; do
  f=$APP_DIR/build/icons/\${s}x\${s}.png
  [ -f "\$f" ] || continue
  install -D -m 0644 "\$f" %{buildroot}/usr/share/icons/hicolor/\${s}x\${s}/apps/camic.png
done

%files
%defattr(-,root,root,-)
/opt/camic
/usr/bin/camic
/usr/share/applications/camic.desktop
/usr/share/icons/hicolor/*/apps/camic.png

%changelog
* $(date '+%a %b %d %Y') $MAINTAINER - $VERSION-1
- Initial package
SPEC

  rpmbuild -bb "$spec" \
    --define "_topdir $top" \
    --define "debug_package %{nil}" \
    --define "__os_install_post %{nil}" \
    --define "buildhost camic" \
    2>&1 | tail -5

  local built
  built=$(find "$top/RPMS" -name 'camic-*.rpm' | head -1)
  [ -n "$built" ] || { echo "rpm build failed" >&2; exit 1; }
  cp "$built" "$OUT/camic-$VERSION.$ARCH_RPM.rpm"
  echo "built: $OUT/camic-$VERSION.$ARCH_RPM.rpm ($(du -h "$OUT/camic-$VERSION.$ARCH_RPM.rpm" | cut -f1))"
}

case "$WHAT" in
  deb) build_deb ;;
  rpm) build_rpm ;;
  all) build_deb; build_rpm ;;
  *) echo "usage: $0 [deb|rpm|all]" >&2; exit 2 ;;
esac

echo "----"
ls -la "$OUT"

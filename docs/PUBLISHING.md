# Publishing Camic

How to get the built packages in [`dist/`](../dist/) into users' hands via **apt** (Ubuntu/Debian),
**dnf** (Fedora), the **Snap Store**, and **Flathub**.

Release artifacts:

| File | For |
|---|---|
| `camic-<ver>-amd64.deb` | Ubuntu / Debian |
| `camic-<ver>.x86_64.rpm` | Fedora / RHEL / openSUSE (rpm-based) |
| `Camic-<ver>-x86_64.AppImage` | any distro, no install |
| `camic-<ver>-android.apk` | sideloaded Android |
| `SHA256SUMS` | checksums for all of the above |

---

## 0. Cut a release

```bash
# 1. bump the version everywhere
npm --prefix desktop version 1.1.0        # desktop/package.json
#    mobile: pubspec.yaml version + android/app/build.gradle versionName/versionCode

# 2. rebuild everything
cd desktop && npx electron-builder --linux dir && cd ..
scripts/build-linux-packages.sh
(cd mobile && flutter build apk --release && \
   cp build/app/outputs/flutter-apk/app-release.apk dist/camic-1.1.0-android.apk)
(cd dist && sha256sum camic-1.1.0* Camic-1.1.0* > SHA256SUMS)

# 3. tag
git tag -a v1.1.0 -m "Camic 1.1.0" && git push --tags
```

Pick a GPG key once and reuse it — a repo whose signing key keeps changing trains
users to click through warnings:

```bash
export CAMPUB="YOUR_KEY_ID"        # gpg --list-keys --keyid-format long
```

---

## 1. apt (Ubuntu / Debian)

Two routes. **A** is a self-hosted binary repo — works today, no review queue.
**B** is a Launchpad PPA — integrates with Ubuntu tooling but requires **source** packages.

### A. Self-hosted binary repository (recommended to start)

`.deb` files are already built; a Debian repo is just a directory of them plus metadata.

```bash
mkdir -p repo/debian/{pool,conf,gpg}
cp dist/camic-1.1.0-amd64.deb repo/debian/pool/

# export and dearmor the public key
gpg --armor --export "$CAMPUB" > repo/debian/gpg/KEY.gpg

# metadata
cd repo/debian
dpkg-scanpackages --multiversion pool /dev/null | gzip -9n > dists/Packages.gz
```

For a nicer layout (`dists/<suite>/…`, `Release`, `InRelease`) use `reprepro` or
`apt-ftparchive` instead:

```bash
# reprepro alternative
cat > conf/distributions <<'EOF'
Origin: Camic
Label: Camic
Codename: stable
Architectures: amd64
Components: main
Description: Camic wireless webcam packages
EOF
reprepro includedeb stable pool/camic-1.1.0-amd64.deb
```

Sign the metadata (users will refuse an unsigned repo):

```bash
cd repo/debian
gpg --default-key "$CAMPUB" --digest-algo SHA256 \
    --detach-sign -o dists/Release.gpg dists/Release
gpg --default-key "$CAMPUB" --digest-algo SHA256 \
    --clearsign -o dists/InRelease dists/Release
```

Host it — GitHub Pages, an S3 bucket, or any static web server:

```bash
# e.g. push repo/ to the gh-pages branch, or:
aws s3 sync repo/debian s3://YOUR-BUCKET/camic/debian --acl public-read
```

Users then run:

```bash
curl -fsSL https://YOUR-APT-HOST/camic/debian/gpg/KEY.gpg | sudo gpg --dearmor \
  -o /usr/share/keyrings/camic.gpg
echo "deb [signed-by=/usr/share/keyrings/camic.gpg] https://YOUR-APT-HOST/camic/debian ./" | \
  sudo tee /etc/apt/sources.list.d/camic.list
sudo apt update && sudo apt install camic
```

Verify on a clean box/VM before announcing:

```bash
docker run --rm -it ubuntu:24.04 bash -c "
  apt-get update && apt-get install -y curl gnupg &&
  curl -fsSL https://YOUR-APT-HOST/camic/debian/gpg/KEY.gpg | gpg --dearmor > /usr/share/keyrings/camic.gpg &&
  echo 'deb [signed-by=/usr/share/keyrings/camic.gpg] https://YOUR-APT-HOST/camic/debian ./' > /etc/apt/sources.list.d/camic.list &&
  apt-get update && apt-get install -y camic && dpkg -L camic"
```

### B. Launchpad PPA (official Ubuntu integration)

A PPA builds from **source**, so you need a proper source package, not just the `.deb`:

```bash
# install packaging tools
sudo apt install devscripts build-essential debhelper dh-make quilt

# turn the repo into a source package
cd desktop
dh_make --createorig -s -p camic_1.1.0        # once; produces .orig.tar.gz
debuild -S -sa                                  # produces .dsc + .debian.tar.xz + . changes

# upload (needs a Launchpad account with an SSH + GPG key registered)
dput ppa:YOUR_LP_USER/camic camic_1.1.0_source.changes
```

Launchpad builds `.deb`s for every Ubuntu series you enabled; users add:

```bash
sudo add-apt-repository ppa:YOUR_LP_USER/camic
sudo apt update && sudo apt install camic
```

> A PPA cannot ship a prebuilt Electron binary as a "source" — you either vendor the
> Electron download with a `debian/rules` that unpacks it, or build from the git tree.

---

## 2. dnf (Fedora / rpm-based)

Same idea: either self-host a repo, or use COPR.

### A. Self-hosted repository

```bash
mkdir -p repo/fedora/{Packages,repodata}
cp dist/camic-1.1.0.x86_64.rpm repo/fedora/Packages/

# import the signing key into the repo metadata
gpg --armor --export "$CAMPUB" > repo/fedora/RPM-GPG-KEY-camic

# build repodata
sudo dnf install createrepo_c
createrepo_c repo/fedora

# sign the metadata
find repo/fedora/repodata -name 'repomd.xml' -exec \
  gpg --default-key "$CAMPUB" --detach-sign --armor {} \;
```

Ship the `.repo` file:

```bash
cat > repo/fedora/camic.repo <<'EOF'
[camic]
name=Camic - wireless webcam
baseurl=https://YOUR-DNF-HOST/camic/fedora/
enabled=1
gpgcheck=1
gpgkey=https://YOUR-DNF-HOST/camic/fedora/RPM-GPG-KEY-camic
EOF
```

Users:

```bash
sudo dnf config-manager --add-repo https://YOUR-DNF-HOST/camic/fedora/camic.repo
sudo dnf install camic
# or, for a one-off:
sudo dnf install ./camic-1.1.0.x86_64.rpm
```

Check it with a clean container:

```bash
docker run --rm -it fedora:41 bash -c "
  dnf install -y 'dnf-command(config-manager)' &&
  dnf config-manager --add-repo https://YOUR-DNF-HOST/camic/fedora/camic.repo &&
  dnf install -y camic && rpm -ql camic | head"
```

### B. COPR (Fedora-native, no server of your own)

COPR builds from source, so publish the spec + the prebuilt payload as sources:

```bash
sudo dnf install copr-cli rpm-build
copr-cli login --token ~/.config/copr/token

# the spec must list the payload tarball as Source0 and be buildable from it
rpmbuild -bs ~/rpmbuild/SPECS/camic.spec          # -> camic-1.1.0-1.fc41.src.rpm
copr-cli add-package YOUR_USER/camic \
  --type local --sources ~/rpmbuild/SRPMS/camic-1.1.0-1.fc41.src.rpm
```

Users:

```bash
sudo dnf copr enable YOUR_USER/camic
sudo dnf install camic
```

> COPR is per-user and per-distro-release; enable it for the Fedora releases you test.

### C. Fedora official repositories

Getting into the real Fedora repos is a source-only, review-driven process:

1. Read the [package review guidelines](https://docs.fedoraproject.org/en-US/package-review-guidelines/).
2. Ensure the spec follows them — **no prebuilt binaries** (Electron must come from a
   `electron` source RPM), `%autosetup`/`%build`/`%check`, changelog, license tagging.
3. Build an SRPM, run `fedora-review`, and open a review request on Bugzilla
   (component `Package Review`).
4. After approval, you get a `dist-git` branch and can `fedpkg build` / `fedpkg request-branch`.

Plan for weeks-to-months of review, and for needing a maintainer sponsor.

---

## 3. Flatpak (Flathub)

Manifest: [`packaging/flatpak/com.camic.Camic.yml`](../packaging/flatpak/com.camic.Camic.yml).

```bash
sudo dnf install flatpak flatpak-builder
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install flathub org.freedesktop.Platform//25.08 org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08

flatpak-builder --user --install --force-clean build-dir packaging/flatpak/com.camic.Camic.yml
flatpak run com.camic.Camic
```

Publishing to Flathub:

1. Fork [flathub/flathub](https://github.com/flathub/flathub) and add
   `com.camic.Camic.yml` (Flathub requires **offline sources** — replace the Node
   download URL with one you host, and add its `sha256`).
2. Replace the commented screenshot URLs in `com.camic.Camic.metainfo.xml` with
   real, publicly reachable PNGs.
3. Open a pull request; CI runs `flatpak-builder-lint` and builds it.
4. Once merged, Flathub builds and publishes — users run:

```bash
flatpak install flathub com.camic.Camic
```

---

## 4. Snap (Snap Store)

Manifest: [`snap/snapcraft.yaml`](../snap/snapcraft.yaml).

```bash
sudo snap install snapcraft --classic
cd snap && snapcraft pack          # produces camic_1.1.0_amd64.snap
sudo snap install --dangerous camic_1.1.0_amd64.snap
```

Publishing:

```bash
snapcraft login
snapcraft upload --release=candidate camic_1.1.0_amd64.snap
# after QA:
snapcraft promote camic --from=candidate --to=stable
```

The snap needs `classic`-free confinement (it already uses `strict` with the
`camera`, `pulseaudio`, `network` plugs); a webcam device usually requires
`sudo snap connect camic:camera` and `sudo snap connect camic:pulseaudio`.

---

## 5. Android APK

The APK is sideloaded today:

```bash
adb install -r dist/camic-1.1.0-android.apk
```

To publish properly:

1. Create a Play Console account and an app.
2. Build a **signed** AAB, not an APK:
   ```bash
   keytool -genkey -v -keystore ~/camic-release.jks -keyalg RSA -keysize 2048 \
     -validity 10000 -alias camic
   cd mobile && flutter build appbundle --release
   ```
   wire the keystore into `android/key.properties` (see `docs/BUILD_ANDROID.md`).
3. Upload `build/app/outputs/bundle/release/app-release.aab`, fill the data-safety
   form, add the screenshots from `docs/images/`, and submit for review.

Or keep sideloading and host the APK next to the GitHub release — that is what the
`dist/` folder is for.

---

## 6. Automate it

`.github/workflows/ci.yml` already builds `AppImage`/`tar.gz` on every push. Add a
`release` job that triggers on tags:

```yaml
  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [linux-desktop, android]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
      - name: Sign
        run: |
          echo "$GPG_PRIVATE_KEY" | gpg --batch --import
          gpg --batch --yes --detach-sign --armor dist/*.deb dist/*.rpm
          (cd dist && sha256sum *.deb *.rpm *.AppImage *.apk *.tar.gz > SHA256SUMS)
      - name: Upload to the repo buckets
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          aws s3 sync dist s3://YOUR-BUCKET/camic/ --acl public-read
```

Whatever you host, the two things that break installs are **unsigned metadata** and
**missing `gpgcheck=1` / `signed-by=`** — never ship a repo users must add with
`trusted=yes`.

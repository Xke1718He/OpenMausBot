# Ubuntu 20.04 compatibility desktop

Build the helper and run the isolated fixture with Node.js 24+ and Docker:

```sh
pnpm build:x11:linux
node scripts/verify-x11-compat.ts
```

The script launches the standard disposable verification server and runs
`control-omb doctor` against its explicit URL. It builds an Ubuntu 20.04 image,
then starts Xvfb, Openbox and an input event window inside an unprivileged
container. The container has a private home, no network, a read-only root and
no mount of the host's display, credentials or user data. Docker is needed only
for this verification recipe, not for the installed desktop app.

The fixture checks explicit opt-in, rejection of Wayland and malformed
connections, private runtime discovery, the server's descriptor validation and
gated transport configuration. It observes actual PNG screenshots and mouse and
keyboard events, rejects reused snapshots, out-of-bounds input, a wrong window
PID and malformed shortcuts, then checks disable, re-enable and shutdown cleanup.

To also check the packaged renderer, embedded server and compatibility helper
using Electron's own Node runtime:

```sh
pnpm package:linux:20.04
node scripts/verify-linux20-package.mjs
OMB_X11_TEST_PACKAGE_DIR="$PWD/release/ubuntu20.04/linux-unpacked" \
  node scripts/verify-x11-compat.ts
node scripts/verify-linux20-install.mjs \
  release/ubuntu20.04/OpenMausBot-0.1.180-ubuntu20.04-amd64.deb
```

The Electron smoke uses `--no-sandbox` only inside the isolated test container.
The installed desktop launcher keeps its normal sandbox configuration.

The packaged startup check also creates a private nvm installation of the fake
Codex CLI and an obsolete Node stand-in first on a desktop-style `PATH`. It drives
the packaged renderer through loopback DevTools, creates a disposable bot and
observes a completed scripted Codex reply. Runtime records must show the nvm
Node and the obsolete launcher must never run. No real Codex login or model is
used, and no DevTools endpoint is exposed outside the container.

The installation check uses a separate disposable Ubuntu 20.04 container as
root, with desktop package dependencies preinstalled and the `.deb` mounted
read-only. It runs APT and dpkg, checks the installed owner, permissions and
Chromium sandbox, repeats configuration and installation, audits dpkg and removes
the package. It never installs into the host. Replace the version in the command
with the built version. Passing a previous failing `.deb` as the second argument
also verifies recovery from its half-configured state.

The script prints a JSON evidence path under
`/tmp/openmausbot-verification-evidence/`, and removes its exact container and
temporary workspace. The cached test image remains for repeat runs. Set
`OMB_X11_TEST_BASE_IMAGE` to a trusted, preloaded Ubuntu 20.04 base image when
registry access is unavailable. Proxy environment variables `http_proxy` and
`https_proxy` are forwarded only to the image build.

These checks exercise a virtual X11 desktop. They do not qualify physical GNOME
seats, Wayland, accessibility trees, every keyboard layout, every agent provider
or the bundled browser's separate desktop integration.

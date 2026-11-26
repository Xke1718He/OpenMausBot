# Ubuntu 20.04 compatibility build

The x86_64 compatibility build packages the Electron app and embedded server for
Ubuntu 20.04 with an X11 local-control backend. Installed desktop builds do not
need Docker, Node.js or pnpm. Configured agent CLIs remain separate installations.

## Build and install

Use Node.js 24 or newer and the project's pinned pnpm version:

```sh
nvm use 24
pnpm install --frozen-lockfile
pnpm package:linux:20.04
sudo apt install ./release/ubuntu20.04/OpenMausBot-*-ubuntu20.04-amd64.deb
```

The command creates a `.deb` in `release/ubuntu20.04/` and an unpacked app in
`release/ubuntu20.04/linux-unpacked/`. APT installs `xdotool`, `x11-utils` and
`x11-apps`, along with the usual Electron desktop dependencies. Use APT rather
than `dpkg -i` alone to resolve those dependencies.

If an earlier compatibility package failed during configuration while looking
for `resources/cua-linux-x64`, install the rebuilt package over it:

```sh
sudo dpkg -i ./release/ubuntu20.04/OpenMausBot-*-ubuntu20.04-amd64.deb
```

This target builds the compatibility helper from repository sources and skips
the standard Linux CUA binary download and preflight. The normal
`pnpm package:linux` target still builds the Ubuntu 24.04 release.

Download access is still needed for uncached Electron, browser, cloudflared and
packaging assets. Switching targets does not remove those downloads.

## Starting from the desktop icon

The app can discover npm-installed CLIs under nvm even when the desktop session
has only system directories on its `PATH`. A CLI installed in an nvm version's
`bin` directory with `#!/usr/bin/env node` runs with that version's sibling Node,
and that directory leads the CLI's child `PATH`. This prevents an obsolete system
Node from parsing Codex's launcher. An explicitly configured interpreter is kept.

After installing an updated package, fully quit OpenMausBot and reopen it using
the desktop icon. No terminal `nvm use` command is needed for this launch path.

## Local computer control

Sign in to an **Ubuntu on Xorg** session. OpenMausBot must run as your ordinary
desktop user. Enable local control in the app, then assign the bot to **This
computer**. The compatibility backend has its own saved opt-in; a previous CUA
opt-in does not enable it. Existing bot permissions and per-action approval
checks remain in effect.

The backend supports listing application windows, PNG screenshots, coordinate
clicks, moving the pointer, text input, keyboard shortcuts and scrolling. It
uses the shared desktop pointer and keyboard, activates the target window, and
requires a fresh window snapshot before each action. A snapshot is single-use,
expires after 30 seconds, and becomes invalid when the window's process, title
or bounds change. Disabling local control or quitting the app stops its helper
and invalidates the connection.

This backend has no accessibility element tree, background input, drag operation
or held-key API. Windows without a verifiable local process identity are omitted.
Wayland, remote X11 displays and Linux ARM64 are unavailable for local control.
Use the bot's browser or an isolated computer for workflows needing those features.

The compatibility build produces `.deb` packages only and uses manual updates:
rebuild and install a newer compatibility `.deb` with APT. Automatic upstream
updates are disabled so an Ubuntu 24.04 package cannot replace this backend.

## Verification

See [the isolated Ubuntu 20.04 verification recipe](verification/linux20-desktop.md).
Its virtual X11 desktop never connects to the user's display or existing app data.

# Termalime

A Tauri + React terminal/AI assistant desktop app.

## Development

```bash
npm install
npm run tauri dev
```

> **Linux tip:** if GTK/WebKit headers are not picked up automatically, prefix the dev command with `PKG_CONFIG_PATH=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig:$PKG_CONFIG_PATH` (the same trick works for `cargo check`).

## Production build

```bash
npm run tauri build
```

## Packaging for Ubuntu

1. Install the Linux build dependencies once:

```bash
sudo apt update
sudo apt install -y libgtk-3-dev libwebkit2gtk-4.0-dev build-essential curl wget pkg-config libssl-dev
```

2. Ensure Rust (via [rustup](https://rustup.rs/)) and Node 18+ are on your PATH, then install JS deps:

```bash
npm install
```

3. Build the signed binaries/packages (this runs the Vite build and Tauri bundler):

```bash
PKG_CONFIG_PATH=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig:$PKG_CONFIG_PATH npm run tauri build
```

Artifacts land under `src-tauri/target/release/bundle/`:

- `deb/Termalime_0.1.0_amd64.deb` → installable via `sudo apt install ./Termalime_0.1.0_amd64.deb`
- `appimage/Termalime_0.1.0_amd64.AppImage` → portable, run `chmod +x` then execute
- `rpm/Termalime-0.1.0-1.x86_64.rpm` for Fedora/RHEL derivatives (optional but produced by default)

Update `bundle.targets` or metadata inside `src-tauri/tauri.conf.json` if you need to limit formats or tweak versioning.

## Custom icon & verification

- All platform icon assets live in `src-tauri/icons/`. Regenerate them from a square source logo with `npm run tauri icon ./path/to/logo.png`.
- The bundle icon list in `src-tauri/tauri.conf.json` feeds the Tauri resource bundle. At runtime the main window clones `app.default_window_icon()` (see `src-tauri/src/lib.rs`) so the dock/taskbar icon matches the bundled asset on every platform.
- After swapping icons, rebuild or restart `npm run tauri dev`. On Linux, the WM may cache icons aggressively; if the old icon persists, quit the app and run `rm -rf ~/.cache/tauri/termaline` before relaunching.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

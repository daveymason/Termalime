---
name: verify
description: Build, launch, and drive Termalime (Tauri desktop app) to verify changes end-to-end on Linux.
---

# Verifying Termalime

## Build & test
```bash
# Rust backend tests (from src-tauri/)
PKG_CONFIG_PATH=/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig:$PKG_CONFIG_PATH cargo test
# Frontend typecheck + bundle (from repo root)
npm run build
```

## Launching the app (gotchas)

Snap-installed VSCode leaks GTK/snap env vars that crash the binary with
`symbol lookup error: /snap/core20/.../libpthread.so.0`. Launch with:

```bash
env -u GTK_PATH -u GTK_EXE_PREFIX -u GDK_PIXBUF_MODULE_FILE -u GDK_PIXBUF_MODULEDIR \
    -u GIO_MODULE_DIR -u GSETTINGS_SCHEMA_DIR -u LOCPATH -u GTK_IM_MODULE_FILE \
    XDG_DATA_DIRS="/usr/share/ubuntu:/usr/share/gnome:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop" \
    <command>
```

Dev mode needs the vite server on :1420 (`npm run dev`), then run
`src-tauri/target/debug/Termalime` directly (or `npm run tauri dev` with the
env cleanup above).

## Driving the GUI safely

**Never inject synthetic input into the user's live display (:1)** — the
desktop session is often in active use. Use a nested X server instead;
Xephyr is installed:

```bash
Xephyr :2 -screen 1300x900 -title "Termalime test" &   # appears as one window
DISPLAY=:2 <cleaned-env launch of Termalime>
DISPLAY=:2 import -window root shot.png                 # screenshot
```

No xdotool on this machine. Use python-xlib (XTEST) in a venv for
clicks/keys — a ready-made driver pattern: `xdrive.py` with
`click X Y`, `type "text"`, `key Return`, connecting via $DISPLAY.

## Useful checks
- PTY/shell lifecycle: `ps --ppid $(pgrep -x Termalime) -o cmd= | grep -c 'bash -i'`
  should equal the number of open terminal tabs (dev StrictMode double-mounts
  are cleaned up if `close_pty` works).
- App window is 1280x800; tab bar at top-left (~y=22), terminal pane center
  around (420, 300) on the nested display.
- Chat/preflight features need Ollama on 127.0.0.1:11434 — absent Ollama the
  terminal still works; preflight only intercepts pastes and sidebar commands,
  not typed input.

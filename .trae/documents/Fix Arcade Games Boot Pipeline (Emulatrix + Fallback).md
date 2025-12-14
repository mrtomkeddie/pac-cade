## Summary
Arcade titles are blank because the Emulatrix inner pages (MAME) sometimes fail to initialize BrowserFS/FS and never reach `Module.callMain`, so the canvas stays 0×0. I will make the boot sequence deterministic, surface status in the header, and add a safe fallback to EmulatorJS if Emulatrix cannot start.

## Changes
1. Emulatrix Mount (host `app.js`)
- Always set the inner iframe `src` to the absolute URL of the selected Emulatrix page (`new URL(innerPage, location.href)`), not `contentDocument.location.replace`.
- After `load`, inject `ROMDATA`/`ROMNAME` into the inner window and call: `startFileSystem() → loadRomIntoVD() → startEmulator()`.
- Add robust status updates to `#game-title`: “Loading <rom>…”, “Starting emulator…”, “Running <title>”.
- Add inner error/rejection listeners and forward messages to `#game-title`.
- Keep the existing canvas watcher for aspect sync; after N retries, trigger EmulatorJS fallback (Blob URL from `ROMDATA`).

2. ROM Fetch (host `app.js`)
- Ensure absolute URL fetch for arcade ROMs via `new URL(url, location.href)`, show loading text before fetch.
- If HTTP error or LFS pointer detected, show a clear message and abort gracefully.

3. BrowserFS/FS Init (inner pages `Emulatrix_MAME2003.js`, `Emulatrix_MAME32.js` and lite equivalents)
- Gate `startFileSystem()` until both `window.BrowserFS` and `FS` are available; retry with a small delay.
- Use the `window.BrowserFS` global explicitly to avoid shadowing.
- Keep the in‑memory mount to avoid storage permissions.

4. Startup Overlay Visibility (host `app.js`)
- Unhide the inner “Starting Emulator” overlay: remove `.gui_pleasewait` from the hidden list, keep `.gui_loading`/`.gui_saving` hidden.

5. Aspect Ratio & Fullscreen (CSS + host)
- Confirm `.is-fullscreen .theme-arcade .emulator-wrap` uses `min(100vw, calc(100vh * var(--emu-aspect-w) / var(--emu-aspect-h)))` and centers correctly.
- On canvas ready, set `--emu-aspect-w/h` and update host wrapper style.

6. Diagnostics & Logging
- Add header status messages during each stage and show core errors (Network/Core/FS) in `#game-title`.
- Console logs for each transition (fetch → mount → FS → ROM → start → canvas ready).

## Files to Update
- `app.js`
  - Emulatrix mount and inner load flow: 667–820
  - ROM fetch and Emulatrix start: 1216–1233
  - Arcade click/fullscreen and status: 1246–1271
  - Aspect watcher/resizer in game view: 436–463
  - Prefer Emulatrix helper: 2099–2120
- `styles-v4.css`
  - `.is-fullscreen .theme-arcade` and `.emulator-wrap` centering (already added; verify values)
- `Emulatrix_MAME2003.js`, `Emulatrix_MAME32.js`
  - Harden `startFileSystem()` to wait for `BrowserFS` + `FS` and use `window.BrowserFS`.
- Lite equivalents:
  - `Pac-Cade-lite/Pac-Cade-lite/app.js` (same inner mount flow)
  - `Pac-Cade-lite/Pac-Cade-lite/Emulatrix_MAME2003.js`, `Emulatrix_MAME32.js` (same FS gating)

## Verification
- Run via `http://localhost:8000/`, test:
  - `pacman.zip`, `dkong.zip`, `invaders.zip`, `mario.zip` in Arcade Room.
  - Observe “Loading …” → “Starting emulator…” → canvas appears; controls work.
  - Press `Esc` to return; re‑launch other titles.
- Confirm fallback triggers if Emulatrix still stalls (should start via EmulatorJS).

## Rollback/Safety
- Changes are confined to boot pipeline and CSS visibility; no persistent storage writes.
- IndexedDB remains disabled; FS is in‑memory.

## Deliverables
- Arcade titles boot consistently in fullscreen with correct aspect.
- Visible status messages during loading/boot.
- Deterministic FS/ROM/start sequencing with a working fallback.
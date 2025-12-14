## Summary
The “Script error” persists because the remote EmulatorJS loader or the nested Emulatrix pages are failing silently. We will bypass external loaders and the nested Emulatrix.htm by creating a small, single‑iframe local runner that loads the already‑bundled `Emulatrix_MAME2003.js` from your repo, writes the ROM into `FS`, and calls the core directly. This avoids cross‑origin issues and eliminates the fragile double‑iframe chain.

## Approach
- Use a direct runner iframe (`srcdoc`) that:
  1) Creates a canvas and sets `Module.canvas`.
  2) Loads `Emulatrix_MAME2003.js` locally (contains the core and BrowserFS).
  3) Waits for `Module` and `FS` to be ready.
  4) Writes the ROM (`parent.ROMDATA`) into the virtual filesystem.
  5) Generates minimal `retroarch.cfg` and `retroarch-core-options.cfg` entries.
  6) Calls `Module.callMain(["-v", "/<romname>"])`.
  7) Resizes the canvas and reports status in `#game-title`.
- Route all arcade `.zip` ROM launches to this runner. Keep consoles on their existing paths.
- Keep fullscreen/aspect handling and status updates.
- Provide fallback to the existing Emulatrix page only if the direct runner reports a core initialization error.

## Implementation Steps
1) Add `mountMame2003Direct(theme, name, data)` in `app.js` (mirroring existing `mountGenesisPlusGX` pattern):
- Build `srcdoc` with a canvas and minimal styles.
- Inject scripts:
  - `<script src="Emulatrix_MAME2003.js"></script>`
  - Inline boot script:
    - Poll `Module`/`FS` readiness.
    - `FS.createDataFile('/', name, parent.ROMDATA, true, false)`
    - Create folders under `/home/web_user/retroarch/userdata`.
    - Write minimal config (start button=Enter, coin=Digit1, audio enabled, vsync, aspect auto).
    - `Module.callMain(["-v", "/"+name])`.
    - Resize `Module.canvas` to iframe container.
    - Report success/failure to the host via `parent.qs('#game-title')`.

2) Update `startEmulatorUrl(core, url, theme)` and `startEmulator(core, file, theme)`:
- Detect `.zip` + `theme==='arcade'` → fetch/convert to `Uint8Array` and call `mountMame2003Direct(theme, romName, data)`. Do not use EmulatorJS CDN.
- Keep current console core paths unchanged.
- Keep fallback to the existing Emulatrix page if direct runner reports failure.

3) Status & Aspect
- Update `#game-title` during stages: “Loading <rom>…”, “Starting arcade core…”, then the game name.
- On canvas ready, set `--emu-aspect-w/h` from `Module.canvas.width/height` and update host wrapper style as today.

4) Diagnostics
- In the runner, add `window.onerror` and `unhandledrejection` handlers that write the error string to `#game-title` in the host, to avoid “Script error” with no details.
- Console log core boot transitions in both runner and host for troubleshooting.

## Files to Update
- `app.js`:
  - New `mountMame2003Direct()` function.
  - Route arcade zip games in `startEmulatorUrl()` and `startEmulator()` to the direct runner.
  - Preserve existing fullscreen/aspect and controller mapping logic.

## Verification
- Hard refresh `http://localhost:8000/`.
- Launch `pacman.zip`, `dkong.zip`, `invaders.zip`, `mario.zip` from the Arcade Room.
- Expect header updates and canvas to appear; controls: `WASD`/arrows, `Space`, `Enter`, `1`. `Esc` returns.

## Rollback
- If anything regresses, switch arcade routing back to Emulatrix (already present). No external CDN reliance either way.

## Deliverable
- Arcade games run locally and consistently with visible status and robust error reporting, no CDN dependency.
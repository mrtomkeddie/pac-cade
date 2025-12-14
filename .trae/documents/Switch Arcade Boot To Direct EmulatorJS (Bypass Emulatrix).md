## Summary
Arcade titles still stall in Emulatrix. To get them working smoothly, route arcade games directly through EmulatorJS (MAME2003 core), bypassing the Emulatrix outer/inner pages entirely. Keep absolute ROM URLs, show visible status, and retain fullscreen/aspect behavior.

## Changes
1. Direct EJS Launch for Arcade (`app.js`)
- In `startEmulatorUrl(core, url, theme)` and `startEmulator(core, file, theme)`, if `theme==='arcade'` and extension is `.zip`, skip `preferEmulatrix` and call a new `startArcadeEJS(urlOrBlob, theme)`.
- `startArcadeEJS` sets `window.EJS_player`, `window.EJS_core='mame2003'`, and `window.EJS_gameUrl` to an absolute URL for URLs or `URL.createObjectURL(new Blob([ROMDATA],{type:'application/zip'}))` when data is present.
- Show header status: “Loading <rom>…”, then “Starting arcade emulator…”. Handle errors visibly.
- Load `https://cdn.emulatorjs.org/stable/data/loader.js` once; catch rejections.

2. Remove Emulatrix Dependency in Arcade Path (`app.js`)
- Do not create `Emulatrix.htm` iframe for arcade any more; only for console/core types that need it.
- Keep existing fullscreen/aspect handling in `toGameView()` and watchers.

3. Keep Emulatrix For Console Cores
- NES/SNES/GB/GBA/Genesis remain on Emulatrix (already working); only MAME zip cores switch to direct EJS.

4. Visible Status & Errors
- Update `#game-title` through stages; on failure, show the error and advise retry.
- Add minimal console logging: core, URL, loader fired, emulator ready.

5. CSS/Aspect/Fullscreen
- No CSS changes required; current `.is-fullscreen .theme-arcade` rules already center with letterbox. Aspect sync stays via canvas size from EJS.

## Files to Update
- `app.js`
  - Add `startArcadeEJS(...)` helper and call it for arcade zip games in `startEmulatorUrl` and `startEmulator`.
  - Remove Emulatrix mount call for arcade zip path.
  - Keep existing status updates and fullscreen logic.

## Verification
- Hard refresh `http://localhost:8000/`.
- Launch `pacman.zip`, `dkong.zip`, `invaders.zip`, `mario.zip`.
- Observe “Loading …” then “Starting arcade emulator…”, then gameplay.
- Confirm controls and `Esc` to return.

## Rollback/Safety
- Changes are isolated to routing; Emulatrix remains available for consoles.
- No persistent storage or IndexedDB used.

## Deliverables
- Arcade games boot consistently via EJS, with status messaging and fullscreen/aspect retained.
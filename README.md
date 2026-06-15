# Blocked Client

A bare-bones, performance-optimized [bloxd.io](https://bloxd.io) client built with the latest Electron. No extra features — just a clean window tuned to squeeze out as much FPS as possible.

## What it does

- Loads bloxd.io in a single, locked-down Electron window titled **Blocked Client**.
- Forces hardware acceleration and GPU rasterization on.
- Vsync stays on by default for smooth combat (see note below).
- Never throttles the renderer when unfocused or covered.
- Blocks ad/tracker networks at the network layer.
- Keeps Google / Apple / Microsoft / Discord logins working (auth popups open
  in-app instead of being bounced to the browser).
- **Alt+F4** quits the app, even while the game has keyboard focus.

## Run it

```bash
npm install
npm start
```

## Build a Windows installer

```bash
npm run dist:win
```

The installer is written to the `dist/` folder.

## Build a macOS download

A macOS `.dmg` can only be built on macOS (electron-builder needs Apple's
`hdiutil`), so it can't be produced from Windows. Two ways to get one:

**On a Mac:**

```bash
npm install
npm run dist:mac
```

This writes `Blocked Client-<version>-arm64.dmg` (Apple Silicon) and
`Blocked Client-<version>-x64.dmg` (Intel) to the `dist/` folder.

**From this repo's CI (no Mac required):** the [Build macOS](.github/workflows/build-mac.yml)
GitHub Actions workflow builds the `.dmg` files on a macOS runner.

- Run it manually from the repo's **Actions** tab → *Build macOS* → *Run workflow*,
  then download the `.dmg` from the run's artifacts.
- Or push a `v*` tag (e.g. `git tag v1.0.0 && git push origin v1.0.0`) to also
  publish the `.dmg` files to a GitHub Release.

> The build is **unsigned** (no Apple Developer ID). On first launch macOS
> Gatekeeper will block it — right-click the app and choose **Open**, or run
> `xattr -dr com.apple.quarantine "/Applications/Blocked Client.app"`.

## Performance tweaks

All optimizations live in [main.js](main.js):

| Switch | Effect |
| --- | --- |
| `ignore-gpu-blocklist` | Enables GPU accel on blocklisted hardware. |
| `enable-gpu-rasterization` | GPU-driven rendering. |
| `disable-features=CalculateNativeWinOcclusion` | Full speed even when the window is covered. |
| `backgroundThrottling: false` | Full speed even when unfocused. |

### Why vsync is on by default (the hit-freeze fix)

Uncapping the frame rate runs the GPU flat-out with no spare budget. The moment a
hit adds extra draw work (effects/particles), there's no headroom to absorb it,
so you get a stutter on every hit/get-hit — even though the FPS *number* is high.
Vsync on keeps the GPU paced with headroom, so combat stays smooth.

```bash
npm start        # smooth (vsync on) — recommended
npm run uncap    # raw uncapped FPS (electron . --uncap) — brings the freeze back
npm run debug    # records diagnostics.log for performance analysis
```

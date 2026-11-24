# Leaving react-grid-layout

Status: plan. No code depends on this yet beyond `ui/src/features/insights/grid-geometry.ts`, which holds
the pixel geometry (row height, gaps, column width) that the canvas and its footprints share.

## Why the patch exists

The canvas pins `react-grid-layout` 2.3.0 and carries `ui/patches/react-grid-layout+2.3.0.patch`. The patch
forwards react-draggable's `enableUserSelectHack` option through `dragConfig` and `resizeConfig`, and Paprika
sets it to off. With the hack on, every press adds a body class and a global `*::selection { all: inherit }`
rule, which restyles thousands of chart descendants on each press and release. The canvas gesture surface
already prevents native text selection, so the hack only costs time. The default stays unchanged for other users.

## Exit path, in order of preference

1. **Upstream option.** Open an upstream pull request that forwards `enableUserSelectHack` through
   `dragConfig` and `resizeConfig`. The patch is the diff to send. Once a release includes it, upgrade and
   delete the patch file and its `patch-package` entry in the same change.
2. **Drop the patch in that release.** Only after `ui/e2e/insights-edit-performance.e2e.mjs` passes on the new
   version. That script exercises real drag and resize handles, rejects the global selection rule and class, and
   checks the saved layout after reload.
3. **If upstream refuses or stalls,** choose one of the fallbacks below. Each has a cost.

## Fallbacks and their cost

| Option | What it means | Cost |
|---|---|---|
| Stay pinned at 2.3.0 with the patch | Keep the patch; re-check on each dependency bump. | Security and bug fixes in the library need a manual rebase of the patch. `patch-package` fails installation on a mismatch, so a bump is never silent. |
| Vendored fork | Copy the library source into `ui/src/vendor/` with the option built in. | We own the drag, resize and collision code, and every upstream fix must be ported by hand. |
| Own grid on `grid-geometry.ts` | Replace the library with a small grid that uses the shared geometry module. | The largest cost: drag, resize, collision, keyboard moves and the screen-reader announcements all need rebuilding and re-testing against the existing edit and performance scripts. Only worth it if the library stops being maintained. |

## Scope

- No viewport-width mode. The canvas projection (`canvasMode`) decides wide, compact or stacked from the
  measured canvas width, and that stays the same whichever grid is in use.
- The geometry in `grid-geometry.ts` is the single source for row height, gaps and column width. A replacement
  grid must read those values rather than add new literals, and `responsive-layout-parity.test.ts` must still
  pass without regenerating its snapshot.

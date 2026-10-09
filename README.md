# svg-sdf

Signed distance fields from SVG geometry, computed into a fixed-resolution buffer and post-processed on the GPU in a pannable, zoomable viewer.

```
bun install
bun run dev        # viewer on http://localhost:3112
bun run test       # unit tests
bun run build      # typecheck + static build into ./build
```

Every push to the default branch is tested, built and published to GitHub Pages by `.github/workflows/deploy.yml`. Pages has to be enabled once, with Settings → Pages → Source set to **GitHub Actions**.

## How it works

1. **Parse** (`src/lib/svg`): the SVG is read with `DOMParser`. Paths, rects, circles, ellipses, lines, polylines, polygons, groups and `use` are supported, along with transforms, inherited fills, inline styles and simple `<style>` rules. Arcs become cubics, and every curve is flattened to within a fraction of a buffer pixel.
2. **Distance** (`src/lib/sdf`): for each buffer pixel centre:
   - the exact distance to the nearest edge segment, found through a BVH;
   - the sign, from a scanline inside test that honours `nonzero` and `evenodd`;
   - the vector to the nearest edge point;
   - the shape id.

   Rows are split across a pool of web workers.

3. **Post-process** (`src/render`): the `Float32Array` buffer is uploaded once as an `RGBA32F` texture. A fragment shader then colours it in one of these modes:
   - **Polar**: hue from the direction to the nearest edge, saturation and value from the distance, optional radial lines.
   - **Ramps**: separate inside and outside colour ramps.
   - **Shapes**: the SVG fill of the pixel's shape, shaded by distance.
   - **Raw**: the grey-scale field.

   Contour lines or bands and an outline can be layered on top. Changing a setting only redraws; it never recomputes the buffer.

4. **View** (`src/view`): drag to pan, wheel or pinch to zoom around the cursor, double-click to fit.

## Buffer layout

`SdfBuffer.data` holds 4 floats per pixel, row major from the top left (SVG y-down):

| channel    | meaning                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `distance` | signed distance to the nearest edge in SVG units, negative inside                                               |
| `dx`, `dy` | vector from the pixel centre to that nearest edge point                                                         |
| `shape`    | topmost filled shape containing the pixel, otherwise the shape owning the nearest edge, `-1` for an empty scene |

The pixel `(i, j)` has its centre at `region.min + (i + 0.5, j + 0.5) * pixelSize`. Distances are measured to every edge, including edges where filled shapes overlap. Unfilled shapes only contribute edges.

Exports:

- **`.sdf` binary**: `SSDF` magic, version, JSON header, then little-endian float32 data; see `src/lib/io/sdfFile.ts`.
- **PNG** of the view or of the whole buffer.
- **Settings JSON**.

## Library use

```ts
import { parseSvg, flattenGeometry, computeSdf, computeLayout } from './src/lib';

const geometry = parseSvg(svgText);
const options = { width: 1024, padding: 0.1 };
const { pixelSize } = computeLayout(geometry.bounds, options);
const sdf = computeSdf(flattenGeometry(geometry, 0.25 * pixelSize), options);
```

`SdfWorkerPool` runs the same computation on web workers, with progress reporting and cancellation.

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

1. **Parse** (`src/lib/svg`): the SVG is read with `DOMParser`. Paths, rects, circles, ellipses, lines, polylines, polygons, groups and `use` are supported, along with transforms, inherited fills, inline styles and simple `<style>` rules. Quadratics and arcs become cubics. Curves then take one of two routes, chosen by the _Curves_ flag (`flattenGeometry(geometry, tolerance, 'exact' | 'polyline')`):
   - **exact** (default): curves stay cubic Béziers. They are split into pieces monotone in x and y, and distances are measured to the true curve, so the direction to the nearest edge varies smoothly along it.
   - **polyline**: curves are flattened to within a fraction of a buffer pixel. This is cheaper, but the direction is constant along each straight piece, which shows up as bands in polar mode.
2. **Distance** (`src/lib/sdf`): for each buffer pixel centre:
   - the exact distance to the nearest edge (line or curve piece), found through a BVH. Every metric is a gauge distance d(p, q) = γ(A(q − p)). γ is one of five unit shapes:
     - **Euclidean**: the straight-line distance, with rounded iso-lines.
     - **Manhattan** (L1): the sum of the x and y offsets, with diamond iso-lines.
     - **Chebyshev** (L∞): the larger of the two offsets, with square iso-lines.
     - **Lp**: for 1 < p < ∞, morphing from the diamond through the circle to the square.
     - **Polygon**: a regular n-gon with apothem 1, with polygonal iso-lines. Odd n gives a direction-dependent distance.

     A rotates and stretches the unit shape, for any kind. A rotated Manhattan or Chebyshev grid, or elliptical distance, comes from the same setting. A is applied to the geometry once, so each search only deals with the bare shape; Chebyshev is half the Manhattan distance in coordinates rotated by 45°.

   - the sign, from a scanline inside test that honours `nonzero` and `evenodd`;
   - the vector to the nearest edge point;
   - the shape id.

   The buffer is computed by one of three backends, chosen with the _Compute_ setting:
   - **WebGPU**: a compute shader (`src/lib/gpu/sdf.wgsl`).
   - **WebGL2**: a fragment pass into a float framebuffer on an `OffscreenCanvas` (`src/lib/gpu/sdf.frag.glsl`).
   - **CPU**: up to 8 web workers in float64, the reference.

   _Auto_ tries WebGPU, then WebGL2, then the CPU. It skips software GPUs such as SwiftShader or llvmpipe, which are slower than the CPU workers.

   Both GPU paths run in a worker, tile by tile. The CPU builds the search tree (BVH) and the inside test and packs them relative to the buffer centre in pixel units, so float32 stays precise even at map-scale coordinates. The GPU runs the nearest-edge search per pixel; every metric and both curve modes run on all three backends.

   GPU buffers match the CPU reference to within about 1e-4 buffer px, with identical signs and shape ids. Only where two edges are exactly equally near can the stored nearest point differ.

3. **Post-process** (`src/render`): the `Float32Array` buffer is uploaded once as an `RGBA32F` texture. A fragment shader then colours it in one of these modes:
   - **Polar**: hue from the direction to the nearest edge, the colour's strength from the distance. The hue comes from one of three palettes:
     - **HSV**: a rainbow.
     - **OKLCH**: a perceptually even hue wheel; distance drives chroma and lightness.
     - **Gradient**: your own cyclic stops.

     Optional radial lines, and tiles over the direction × distance plane: a checker, or a mosaic of flat tiles.

   - **Ramps**: separate inside and outside colour ramps.
   - **Shapes**: the SVG fill of the pixel's shape, shaded by distance.
   - **Raw**: the grey-scale field.

   Contour lines or bands and an outline can be layered on top. Changing a setting only redraws; it never recomputes the buffer.

4. **View** (`src/view`): drag to pan, wheel or pinch to zoom around the cursor, double-click to fit.

## Buffer layout

`SdfBuffer.data` holds 4 floats per pixel, row major from the top left (SVG y-down):

| channel    | meaning                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `distance` | signed distance to the nearest edge in SVG units under the buffer's metric, negative inside                     |
| `dx`, `dy` | vector from the pixel centre to that nearest edge point                                                         |
| `shape`    | topmost filled shape containing the pixel, otherwise the shape owning the nearest edge, `-1` for an empty scene |

The pixel `(i, j)` has its centre at `region.min + (i + 0.5, j + 0.5) * pixelSize`. Distances are measured to every edge, including edges where filled shapes overlap. Unfilled shapes only contribute edges.

Exports:

- **`.sdf` binary**: `SSDF` magic, version, JSON header (including the metric), then little-endian float32 data; see `src/lib/io/sdfFile.ts`.
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

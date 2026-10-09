import { Bounds, FillRule, RGBA, Scene, SDF_STRIDE, SdfBuffer, SdfLayout } from '../types';
import { Nearest, SegmentBvh } from './bvh';
import { packSegments, Segments } from './segments';

export interface SdfOptions {
  /** buffer width in pixels, the height follows from the aspect ratio of the region */
  width: number;
  /** margin around the svg bounds, as a fraction of their larger side */
  padding?: number;
  /** overrides the svg bounds as the area to cover, before padding */
  region?: Bounds;
}

/** the pixel grid a buffer of `options.width` covers, with square pixels centred on the padded bounds */
export const computeLayout = (bounds: Bounds, options: SdfOptions): SdfLayout => {
  const b = options.region ?? bounds;
  const pad = (options.padding ?? 0.1) * Math.max(b.maxX - b.minX, b.maxY - b.minY);
  const w = b.maxX - b.minX + 2 * pad;
  const h = b.maxY - b.minY + 2 * pad;
  const width = Math.max(1, Math.round(options.width));
  const pixelSize = w / width;
  const height = Math.max(1, Math.round(h / pixelSize));
  const cy = (b.minY + b.maxY) / 2;
  const minX = b.minX - pad;
  const minY = cy - (height * pixelSize) / 2;
  return { width, height, pixelSize, region: { minX, minY, maxX: minX + w, maxY: minY + height * pixelSize } };
};

/** everything the per-row work needs, built once per scene (and once per worker) */
export interface PreparedScene {
  segments: Segments;
  bvh: SegmentBvh;
  fillRules: FillRule[];
  /** filled segments ordered by their top y, for the scanline inside test */
  byTop: Int32Array;
  top: Float64Array;
  bottom: Float64Array;
}

export const prepareScene = (scene: Scene): PreparedScene => {
  const segments = packSegments(scene);
  const c = segments.coords;
  const filled: number[] = [];
  for (let i = 0; i < segments.count; i++) if (segments.filled[i] && c[i * 4 + 1] !== c[i * 4 + 3]) filled.push(i);
  const top = new Float64Array(segments.count);
  const bottom = new Float64Array(segments.count);
  for (let i = 0; i < segments.count; i++) {
    top[i] = Math.min(c[i * 4 + 1], c[i * 4 + 3]);
    bottom[i] = Math.max(c[i * 4 + 1], c[i * 4 + 3]);
  }
  filled.sort((a, b) => top[a] - top[b]);
  return {
    segments,
    bvh: new SegmentBvh(segments),
    fillRules: scene.shapes.map((s) => s.fillRule),
    byTop: Int32Array.from(filled),
    top,
    bottom
  };
};

/**
 * Computes rows [rowStart, rowEnd) of the distance field into `out`, which holds exactly those rows.
 * Per pixel centre: the exact distance to the nearest edge, signed by a scanline inside test, the vector to the
 * nearest point and the shape id (see SdfBuffer).
 */
export const computeRows = (
  prepared: PreparedScene,
  layout: SdfLayout,
  rowStart: number,
  rowEnd: number,
  out: Float32Array = new Float32Array((rowEnd - rowStart) * layout.width * SDF_STRIDE)
): Float32Array => {
  const { width, pixelSize, region } = layout;
  const { segments, bvh, fillRules, byTop, top, bottom } = prepared;
  const c = segments.coords;
  const nearest: Nearest = { d2: Infinity, x: 0, y: 0, segment: -1 };
  const empty = segments.count === 0;
  const far = Math.hypot(region.maxX - region.minX, region.maxY - region.minY);

  // scanline state
  const winding = new Int32Array(fillRules.length);
  const insideList: number[] = [];
  const active: number[] = [];
  let next = 0;
  const crossX: number[] = [];
  const crossSeg: number[] = [];
  const crossOrder: number[] = [];

  for (let j = rowStart; j < rowEnd; j++) {
    const py = region.minY + (j + 0.5) * pixelSize;

    // segments crossing the half-open line y = py: top <= py < bottom
    while (next < byTop.length && top[byTop[next]] <= py) active.push(byTop[next++]);
    for (let k = active.length - 1; k >= 0; k--)
      if (bottom[active[k]] <= py) {
        active[k] = active[active.length - 1];
        active.pop();
      }
    crossX.length = crossSeg.length = crossOrder.length = 0;
    for (const s of active) {
      const ay = c[s * 4 + 1];
      const by = c[s * 4 + 3];
      const ax = c[s * 4];
      crossX.push(ax + ((py - ay) * (c[s * 4 + 2] - ax)) / (by - ay));
      crossSeg.push(s);
      crossOrder.push(crossOrder.length);
    }
    crossOrder.sort((a, b) => crossX[a] - crossX[b]);
    insideList.length = 0;
    let k = 0;
    let hint = -1;
    let o = (j - rowStart) * width * SDF_STRIDE;

    for (let i = 0; i < width; i++, o += SDF_STRIDE) {
      const px = region.minX + (i + 0.5) * pixelSize;

      for (; k < crossOrder.length && crossX[crossOrder[k]] < px; k++) {
        const s = crossSeg[crossOrder[k]];
        const shape = segments.shape[s];
        const before = isInside(winding[shape], fillRules[shape]);
        winding[shape] += c[s * 4 + 3] > c[s * 4 + 1] ? 1 : -1;
        const after = isInside(winding[shape], fillRules[shape]);
        if (before === after) continue;
        if (after) insideList.push(shape);
        else insideList.splice(insideList.indexOf(shape), 1);
      }

      if (empty) {
        out[o] = far;
        out[o + 1] = out[o + 2] = 0;
        out[o + 3] = -1;
        continue;
      }
      bvh.nearest(px, py, nearest, hint);
      hint = nearest.segment;
      const inside = insideList.length > 0;
      out[o] = inside ? -Math.sqrt(nearest.d2) : Math.sqrt(nearest.d2);
      out[o + 1] = nearest.x - px;
      out[o + 2] = nearest.y - py;
      out[o + 3] = inside ? Math.max(...insideList) : segments.shape[nearest.segment];
    }
    // crossings right of the last pixel centre were never applied, start the next row from zero
    for (const s of crossSeg) winding[segments.shape[s]] = 0;
  }
  return out;
};

const isInside = (winding: number, rule: FillRule) => (rule === 'evenodd' ? (winding & 1) === 1 : winding !== 0);

export const sceneColors = (scene: Scene): (RGBA | null)[] => scene.shapes.map((s) => s.fill ?? s.stroke);

/** computes the whole distance field on the calling thread */
export const computeSdf = (scene: Scene, options: SdfOptions): SdfBuffer => {
  const layout = computeLayout(scene.bounds, options);
  const data = computeRows(prepareScene(scene), layout, 0, layout.height);
  return { ...layout, data, colors: sceneColors(scene) };
};

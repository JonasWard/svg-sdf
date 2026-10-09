import {
  Bounds,
  FillRule,
  MetricKind,
  MetricSpec,
  RGBA,
  Scene,
  SDF_STRIDE,
  SdfBuffer,
  SdfLayout,
  toMetricSpec
} from '../types';
import { crossingX } from './bezier';
import { Nearest, SegmentBvh } from './bvh';
import { EDGE_LINE, EDGE_STRIDE, Edges, packEdges } from './edges';
import { metricSetup, MetricSetup, transformEdges } from './metrics';

export interface SdfOptions {
  /** buffer width in pixels, the height follows from the aspect ratio of the region */
  width: number;
  /** margin around the svg bounds, as a fraction of their larger side */
  padding?: number;
  /** overrides the svg bounds as the area to cover, before padding */
  region?: Bounds;
  /** how distances are measured, euclidean by default; a bare kind uses the default shape settings */
  metric?: MetricSpec | MetricKind;
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
  metric: MetricSetup;
  segments: Edges;
  /** over the edges mapped into the metric's search space */
  bvh: SegmentBvh;
  /** shape owning each edge the hierarchy holds, its edges differ from `segments` when the search space is mapped */
  nearestShape: Int32Array;
  fillRules: FillRule[];
  /** filled segments ordered by their top y, for the scanline inside test */
  byTop: Int32Array;
  top: Float64Array;
  bottom: Float64Array;
}

export const prepareScene = (scene: Scene, spec: MetricSpec | MetricKind = 'euclidean'): PreparedScene => {
  const segments = packEdges(scene);
  const c = segments.coords;
  const S = EDGE_STRIDE;
  const filled: number[] = [];
  // edges are monotone in y, so a horizontal one never crosses a scanline
  for (let i = 0; i < segments.count; i++) if (segments.filled[i] && c[i * S + 1] !== c[i * S + 7]) filled.push(i);
  const top = new Float64Array(segments.count);
  const bottom = new Float64Array(segments.count);
  for (let i = 0; i < segments.count; i++) {
    top[i] = Math.min(c[i * S + 1], c[i * S + 7]);
    bottom[i] = Math.max(c[i * S + 1], c[i * S + 7]);
  }
  filled.sort((a, b) => top[a] - top[b]);
  // chebyshev distance is half the manhattan distance in coordinates rotated by 45°
  const metric = metricSetup(toMetricSpec(spec));
  const nearestEdges = metric.matrix ? transformEdges(segments, metric.matrix) : segments;
  return {
    metric,
    segments,
    bvh: new SegmentBvh(nearestEdges, metric.search, metric.p, metric.normals, metric.vertices),
    nearestShape: nearestEdges.shape,
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
  const { segments, bvh, nearestShape, fillRules, byTop, top, bottom } = prepared;
  const c = segments.coords;
  const nearest: Nearest = { score: Infinity, x: 0, y: 0, segment: -1 };
  const { search, matrix: m, inverse: mi, scale, p } = prepared.metric;
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
      const o = s * EDGE_STRIDE;
      if (segments.kind[s] === EDGE_LINE) {
        const ay = c[o + 1];
        const ax = c[o];
        crossX.push(ax + ((py - ay) * (c[o + 6] - ax)) / (c[o + 7] - ay));
      } else crossX.push(crossingX(c, o, py));
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
        winding[shape] += c[s * EDGE_STRIDE + 7] > c[s * EDGE_STRIDE + 1] ? 1 : -1;
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
      // search in the metric's space, then map the nearest point back
      if (m) bvh.nearest(m[0] * px + m[1] * py, m[2] * px + m[3] * py, nearest, hint);
      else bvh.nearest(px, py, nearest, hint);
      const score = nearest.score;
      const base = search === 'l2' ? Math.sqrt(score) : search === 'lp' ? Math.pow(score, 1 / p) : score;
      const distance = base * scale;
      const nx = mi ? mi[0] * nearest.x + mi[1] * nearest.y : nearest.x;
      const ny = mi ? mi[2] * nearest.x + mi[3] * nearest.y : nearest.y;
      hint = nearest.segment;
      const inside = insideList.length > 0;
      out[o] = inside ? -distance : distance;
      out[o + 1] = nx - px;
      out[o + 2] = ny - py;
      out[o + 3] = inside ? Math.max(...insideList) : nearestShape[nearest.segment];
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
  const metric = toMetricSpec(options.metric);
  const data = computeRows(prepareScene(scene, metric), layout, 0, layout.height);
  return { ...layout, data, metric, colors: sceneColors(scene) };
};

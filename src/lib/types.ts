/** 2x3 affine matrix in svg order: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Matrix = [number, number, number, number, number, number];

/** colour channels in 0..1 */
export type RGBA = [number, number, number, number];

export type FillRule = 'nonzero' | 'evenodd';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** one bezier piece of a subpath, all points already in world (svg root) coordinates */
export type PathSegment =
  | { type: 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number };

export interface Subpath {
  x: number;
  y: number;
  segments: PathSegment[];
  closed: boolean;
}

/** a single svg element, curves still exact */
export interface GeometryShape {
  fill: RGBA | null;
  stroke: RGBA | null;
  fillRule: FillRule;
  subpaths: Subpath[];
}

/** the parsed svg: every drawable element in paint order, transforms applied */
export interface SvgGeometry {
  bounds: Bounds;
  shapes: GeometryShape[];
}

/** a flattened subpath, xy pairs */
export interface Contour {
  points: Float64Array;
  closed: boolean;
}

/**
 * The unit shape distances are measured with: a circle (euclidean), diamond (manhattan, L1), square (chebyshev, L∞),
 * Lp ball (lp, 1 < p < ∞) or regular polygon with apothem 1 (polygon).
 */
export type MetricKind = 'euclidean' | 'manhattan' | 'chebyshev' | 'lp' | 'polygon';

/**
 * A gauge distance d(p, q) = γ(A (q - p)): γ is the unit shape of `kind`, A rotates it by `angle` degrees and
 * stretches it by `aspect` along its rotated y axis.
 */
export interface MetricSpec {
  kind: MetricKind;
  /** exponent of the lp kind */
  p: number;
  /** sides of the polygon kind, the first side faces +x */
  sides: number;
  angle: number;
  aspect: number;
}

export const DEFAULT_METRIC: MetricSpec = { kind: 'euclidean', p: 3, sides: 6, angle: 0, aspect: 1 };

/** a full spec from a spec, a bare kind (as older files store it) or nothing */
export const toMetricSpec = (metric: Partial<MetricSpec> | MetricKind | null | undefined): MetricSpec =>
  typeof metric === 'string' ? { ...DEFAULT_METRIC, kind: metric } : { ...DEFAULT_METRIC, ...(metric ?? {}) };

/** how curves enter the distance field: flattened to polylines, or measured exactly as bezier curves */
export type CurveMode = 'polyline' | 'exact';

export interface Shape {
  /** null when the shape only contributes edges, it then has no inside */
  fill: RGBA | null;
  stroke: RGBA | null;
  fillRule: FillRule;
  /** the flattened outline, used in polyline mode */
  contours: Contour[];
  /** the exact outline, used instead of the contours in exact mode; subpaths of filled shapes are closed */
  curves?: Subpath[];
}

/** the flattened svg, what the distance field is computed from */
export interface Scene {
  bounds: Bounds;
  shapes: Shape[];
}

export interface SdfLayout {
  width: number;
  height: number;
  /** the area the buffer covers, in svg units; pixel (i, j) has its centre at region.min + (i + 0.5, j + 0.5) * pixelSize */
  region: Bounds;
  pixelSize: number;
}

/** channels per pixel in an SdfBuffer */
export const SDF_CHANNELS = ['distance', 'dx', 'dy', 'shape'] as const;
export const SDF_STRIDE = SDF_CHANNELS.length;

/**
 * The distance field. Per pixel, row major from the top left (svg y-down):
 * - distance: signed distance to the nearest edge in svg units under the buffer's metric, negative inside
 * - dx, dy: the vector from the pixel centre to that nearest point on the edge
 * - shape: index of the shape the pixel belongs to, the topmost filled shape containing it, otherwise the shape owning the nearest edge
 */
export interface SdfBuffer extends SdfLayout {
  data: Float32Array;
  /** the metric the distances are measured in */
  metric: MetricSpec;
  /** where the buffer was computed: the float64 cpu reference, or a float32 gpu kernel */
  backend?: 'cpu' | 'webgpu' | 'webgl';
  /** display colour per shape index: its fill, else its stroke, else null */
  colors: (RGBA | null)[];
}

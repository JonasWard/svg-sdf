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

export interface Shape {
  /** null when the shape only contributes edges, it then has no inside */
  fill: RGBA | null;
  stroke: RGBA | null;
  fillRule: FillRule;
  contours: Contour[];
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
 * - distance: signed distance to the nearest edge in svg units, negative inside
 * - dx, dy: the vector from the pixel centre to that nearest point on the edge
 * - shape: index of the shape the pixel belongs to, the topmost filled shape containing it, otherwise the shape owning the nearest edge
 */
export interface SdfBuffer extends SdfLayout {
  data: Float32Array;
  /** display colour per shape index: its fill, else its stroke, else null */
  colors: (RGBA | null)[];
}

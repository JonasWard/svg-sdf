import { SdfLayout } from '../types';
import { PreparedScene } from '../sdf/compute';
import { Search } from '../sdf/metrics';

export const SEARCH_INDEX: Record<Search, number> = { l2: 0, l1: 1, lp: 2, polygon: 3 };
/** floats per node and per edge in the packed arrays, in vec4 units of 2 and 3 */
export const NODE_FLOATS = 8;
export const EDGE_FLOATS = 12;
export const MAX_POLYGON_SIDES = 64;

/**
 * The scene as the gpu kernels read it. All coordinates are in the metric's search space, relative to the centre of
 * the buffer region and in buffer pixel units, so float32 keeps them precise for any svg coordinate range:
 * pixel (i, j) queries the point M (i + 0.5 - W / 2, j + 0.5 - H / 2).
 */
export interface PackedScene {
  width: number;
  height: number;
  /** 0 l2, 1 l1, 2 lp, 3 polygon */
  search: number;
  /** search space matrix and its inverse, row major */
  matrix: [number, number, number, number];
  inverse: [number, number, number, number];
  /** world units per search unit: the metric's output scale times the pixel size */
  scale: number;
  /** world units per buffer pixel, for mapping the nearest point back */
  pixelSize: number;
  p: number;
  sides: number;
  /** side normals and vertex directions, xy pairs */
  normals: Float32Array;
  vertices: Float32Array;
  /** per node: minX, minY, maxX, maxY, a, b, 0, 0 (see SegmentBvh.flatten) */
  nodes: Float32Array;
  nodeCount: number;
  /** per edge: 8 control point coordinates, kind, owning shape, 0, 0 */
  edges: Float32Array;
  edgeCount: number;
  /** distance written for every pixel of an empty scene */
  far: number;
}

export const packScene = (prepared: PreparedScene, layout: SdfLayout): PackedScene => {
  const { metric, bvh, nearestShape } = prepared;
  const flat = bvh.flatten();
  const m = metric.matrix ?? [1, 0, 0, 1];
  const mi = metric.inverse ?? [1, 0, 0, 1];
  const ps = layout.pixelSize;
  // the region centre in search space
  const cx = (layout.region.minX + layout.region.maxX) / 2;
  const cy = (layout.region.minY + layout.region.maxY) / 2;
  const sx = m[0] * cx + m[1] * cy;
  const sy = m[2] * cx + m[3] * cy;
  const relX = (x: number) => (x - sx) / ps;
  const relY = (y: number) => (y - sy) / ps;

  const nodes = new Float32Array(Math.max(1, flat.nodeCount) * NODE_FLOATS);
  for (let k = 0; k < flat.nodeCount; k++) {
    const o = k * NODE_FLOATS;
    nodes[o] = relX(flat.nodeBox[k * 4]);
    nodes[o + 1] = relY(flat.nodeBox[k * 4 + 1]);
    nodes[o + 2] = relX(flat.nodeBox[k * 4 + 2]);
    nodes[o + 3] = relY(flat.nodeBox[k * 4 + 3]);
    nodes[o + 4] = flat.nodeA[k];
    nodes[o + 5] = flat.nodeB[k];
  }
  // float32 rounding may shrink a box past an edge it holds; widen every box by a hair so pruning stays safe
  for (let k = 0; k < flat.nodeCount; k++) {
    const o = k * NODE_FLOATS;
    for (let c = 0; c < 4; c++) {
      const v = nodes[o + c];
      const pad = Math.abs(v) * 2 ** -20 + 1e-6;
      nodes[o + c] = c < 2 ? v - pad : v + pad;
    }
  }
  const edgeCount = flat.kind.length;
  const edges = new Float32Array(Math.max(1, edgeCount) * EDGE_FLOATS);
  for (let e = 0; e < edgeCount; e++) {
    const o = e * EDGE_FLOATS;
    for (let c = 0; c < 8; c += 2) {
      edges[o + c] = relX(flat.edges[e * 8 + c]);
      edges[o + c + 1] = relY(flat.edges[e * 8 + c + 1]);
    }
    edges[o + 8] = flat.kind[e];
    edges[o + 9] = nearestShape[flat.edgeId[e]];
  }
  const sides = metric.normals.length / 2;
  if (sides > MAX_POLYGON_SIDES) throw new Error(`at most ${MAX_POLYGON_SIDES} polygon sides on the gpu`);
  const { region } = layout;
  return {
    width: layout.width,
    height: layout.height,
    search: SEARCH_INDEX[metric.search],
    matrix: m,
    inverse: mi,
    scale: metric.scale * ps,
    pixelSize: ps,
    p: metric.p,
    sides,
    normals: Float32Array.from(metric.normals),
    vertices: Float32Array.from(metric.vertices),
    nodes,
    nodeCount: flat.nodeCount,
    edges,
    edgeCount,
    far: Math.hypot(region.maxX - region.minX, region.maxY - region.minY)
  };
};

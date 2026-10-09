import { Scene, Subpath } from '../types';
import { isStraight, lineToCubic, monotonePieces, quadraticToCubic } from './bezier';

export const EDGE_LINE = 0;
export const EDGE_CUBIC = 1;
/** numbers per edge, every edge is stored as a cubic: x0 y0 x1 y1 x2 y2 x3 y3 */
export const EDGE_STRIDE = 8;

/**
 * Every edge of the scene. Lines are stored as cubics with control points at the thirds, so every edge has its
 * start at [0, 1] and its end at [6, 7]; `kind` says whether the cheap line distance applies.
 * Cubics are split into pieces monotone in x and y, so the box of their endpoints is their exact bounding box.
 */
export interface Edges {
  count: number;
  coords: Float64Array;
  kind: Uint8Array;
  /** index into scene.shapes */
  shape: Int32Array;
  /** whether the owning shape is filled, only those take part in the inside test */
  filled: Uint8Array;
  lines: number;
  curves: number;
}

export const packEdges = (scene: Scene): Edges => {
  const coords: number[] = [];
  const kind: number[] = [];
  const shapeIds: number[] = [];
  const filled: number[] = [];

  scene.shapes.forEach((shape, s) => {
    const add = (k: number, c: number[]) => {
      coords.push(...c);
      kind.push(k);
      shapeIds.push(s);
      filled.push(shape.fill ? 1 : 0);
    };
    const line = (x0: number, y0: number, x1: number, y1: number) => {
      if (x0 !== x1 || y0 !== y1) add(EDGE_LINE, lineToCubic(x0, y0, x1, y1));
    };
    const cubic = (c: number[]) => {
      for (const piece of monotonePieces(c)) {
        if (isStraight(piece)) line(piece[0], piece[1], piece[6], piece[7]);
        else add(EDGE_CUBIC, piece);
      }
    };

    for (const c of shape.contours) {
      const p = c.points;
      const n = p.length / 2;
      const last = c.closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const j = (i + 1) % n;
        line(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]);
      }
    }
    for (const sp of shape.curves ?? []) packSubpath(sp, line, cubic);
  });

  return {
    count: kind.length,
    coords: Float64Array.from(coords),
    kind: Uint8Array.from(kind),
    shape: Int32Array.from(shapeIds),
    filled: Uint8Array.from(filled),
    lines: kind.filter((k) => k === EDGE_LINE).length,
    curves: kind.filter((k) => k === EDGE_CUBIC).length
  };
};

const packSubpath = (
  sp: Subpath,
  line: (x0: number, y0: number, x1: number, y1: number) => void,
  cubic: (c: number[]) => void
) => {
  let x = sp.x;
  let y = sp.y;
  for (const seg of sp.segments) {
    if (seg.type === 'L') line(x, y, seg.x, seg.y);
    else if (seg.type === 'Q') cubic(quadraticToCubic(x, y, seg.x1, seg.y1, seg.x, seg.y));
    else cubic([x, y, seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y]);
    x = seg.x;
    y = seg.y;
  }
  if (sp.closed) line(x, y, sp.x, sp.y);
};

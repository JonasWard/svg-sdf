import { Scene } from '../types';

/** every edge of the scene as a flat list of line segments */
export interface Segments {
  count: number;
  /** ax, ay, bx, by per segment */
  coords: Float64Array;
  /** index into scene.shapes */
  shape: Int32Array;
  /** whether the owning shape is filled, only those take part in the inside test */
  filled: Uint8Array;
}

export const packSegments = (scene: Scene): Segments => {
  let count = 0;
  for (const shape of scene.shapes)
    for (const c of shape.contours) {
      const n = c.points.length / 2;
      count += c.closed ? n : n - 1;
    }
  const coords = new Float64Array(count * 4);
  const shapeIds = new Int32Array(count);
  const filled = new Uint8Array(count);
  let k = 0;
  scene.shapes.forEach((shape, s) => {
    for (const c of shape.contours) {
      const p = c.points;
      const n = p.length / 2;
      const last = c.closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const j = (i + 1) % n;
        coords[k * 4] = p[i * 2];
        coords[k * 4 + 1] = p[i * 2 + 1];
        coords[k * 4 + 2] = p[j * 2];
        coords[k * 4 + 3] = p[j * 2 + 1];
        shapeIds[k] = s;
        filled[k] = shape.fill ? 1 : 0;
        k++;
      }
    }
  });
  return { count, coords, shape: shapeIds, filled };
};

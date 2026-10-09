import { nearestOnCubic } from '../sdf/bezier';
import { nearestL1Cubic, nearestL1Line, nearestLp, nearestPolygon } from '../sdf/metrics';
import { EDGE_FLOATS, NODE_FLOATS, PackedScene } from './pack';

/**
 * What the gpu kernels compute for pixel (i, j), done in typescript over the packed arrays. It pins the data layout
 * and the coordinate conventions the shaders rely on, and is the yardstick in the tests.
 * Returns the signed distance, the vector to the nearest point and the shape id, like a buffer pixel.
 */
export const referencePixel = (
  scene: PackedScene,
  i: number,
  j: number,
  insideId: number
): [number, number, number, number] => {
  if (scene.edgeCount === 0) return [scene.far, 0, 0, -1];
  const [m0, m1, m2, m3] = scene.matrix;
  const [i0, i1, i2, i3] = scene.inverse;
  const ux = i + 0.5 - scene.width / 2;
  const uy = j + 0.5 - scene.height / 2;
  const qx = m0 * ux + m1 * uy;
  const qy = m2 * ux + m3 * uy;
  const normals = Float64Array.from(scene.normals);
  const vertices = Float64Array.from(scene.vertices);

  const boxScore = (o: number) => {
    const n = scene.nodes;
    const x0 = n[o] - qx;
    const y0 = n[o + 1] - qy;
    const x1 = n[o + 2] - qx;
    const y1 = n[o + 3] - qy;
    if (scene.search === 3) {
      let bound = 0;
      for (let k = 0; k < scene.sides; k++) {
        const nx = normals[k * 2];
        const ny = normals[k * 2 + 1];
        bound = Math.max(bound, nx * (nx > 0 ? x0 : x1) + ny * (ny > 0 ? y0 : y1));
      }
      return bound;
    }
    const dx = Math.max(x0, 0, -x1);
    const dy = Math.max(y0, 0, -y1);
    if (scene.search === 0) return dx * dx + dy * dy;
    if (scene.search === 1) return dx + dy;
    return dx ** scene.p + dy ** scene.p;
  };

  let best = Infinity;
  let bestX = 0;
  let bestY = 0;
  let bestShape = -1;
  const curve = { d2: 0, x: 0, y: 0, t: 0 };
  const l1 = { d: 0, x: 0, y: 0 };
  const gauge = { score: 0, x: 0, y: 0 };
  const testEdge = (e: number) => {
    const o = e * EDGE_FLOATS;
    const c = Array.from(scene.edges.subarray(o, o + 8));
    const line = scene.edges[o + 8] === 0;
    let score: number;
    let x: number;
    let y: number;
    if (scene.search === 0) {
      if (line) {
        const ex = c[6] - c[0];
        const ey = c[7] - c[1];
        const len2 = ex * ex + ey * ey;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((qx - c[0]) * ex + (qy - c[1]) * ey) / len2)) : 0;
        x = c[0] + t * ex;
        y = c[1] + t * ey;
        score = (x - qx) ** 2 + (y - qy) ** 2;
      } else {
        nearestOnCubic(c, 0, qx, qy, curve);
        [score, x, y] = [curve.d2, curve.x, curve.y];
      }
    } else if (scene.search === 1) {
      (line ? nearestL1Line : nearestL1Cubic)(c, 0, qx, qy, l1);
      [score, x, y] = [l1.d, l1.x, l1.y];
    } else if (scene.search === 2) {
      nearestLp(c, 0, line, qx, qy, scene.p, gauge);
      [score, x, y] = [gauge.score, gauge.x, gauge.y];
    } else {
      nearestPolygon(c, 0, line, qx, qy, normals, vertices, gauge);
      [score, x, y] = [gauge.score, gauge.x, gauge.y];
    }
    if (score < best) {
      best = score;
      bestX = x;
      bestY = y;
      bestShape = scene.edges[o + 9];
    }
  };

  const stack = [0];
  while (stack.length) {
    const node = stack.pop()!;
    const o = node * NODE_FLOATS;
    if (boxScore(o) >= best) continue;
    const a = scene.nodes[o + 4];
    const b = scene.nodes[o + 5];
    if (b > 0) {
      for (let e = a; e < a + b; e++) testEdge(e);
      continue;
    }
    const l = a;
    const r = -b - 1;
    const dl = boxScore(l * NODE_FLOATS);
    const dr = boxScore(r * NODE_FLOATS);
    if (dl < dr) stack.push(r, l);
    else stack.push(l, r);
  }

  const base = scene.search === 0 ? Math.sqrt(best) : scene.search === 2 ? best ** (1 / scene.p) : best;
  const distance = base * scene.scale;
  // the vector to the nearest point, mapped back to world units
  const wx = bestX - qx;
  const wy = bestY - qy;
  return [
    insideId >= 0 ? -distance : distance,
    (i0 * wx + i1 * wy) * scene.pixelSize,
    (i2 * wx + i3 * wy) * scene.pixelSize,
    insideId >= 0 ? insideId : bestShape
  ];
};

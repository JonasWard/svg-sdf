import { Matrix } from '../types';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 * m2, so m2 is applied first */
export const multiply = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
];

export const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5]
];

export const translate = (tx: number, ty = 0): Matrix => [1, 0, 0, 1, tx, ty];
export const scale = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0];
export const rotate = (degrees: number, cx = 0, cy = 0): Matrix => {
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return multiply(translate(cx, cy), multiply([cos, sin, -sin, cos, 0, 0], translate(-cx, -cy)));
};

/** parses an svg `transform` attribute, e.g. `translate(10 20) rotate(45, 5, 5)` */
export const parseTransform = (text: string | null | undefined): Matrix => {
  let m = IDENTITY;
  if (!text) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length)
      .map(Number);
    if (args.some(Number.isNaN)) break;
    let t: Matrix;
    switch (match[1]) {
      case 'matrix':
        if (args.length !== 6) return m;
        t = args as Matrix;
        break;
      case 'translate':
        t = translate(args[0] ?? 0, args[1] ?? 0);
        break;
      case 'scale':
        t = scale(args[0] ?? 1, args[1] ?? args[0] ?? 1);
        break;
      case 'rotate':
        t = rotate(args[0] ?? 0, args[1] ?? 0, args[2] ?? 0);
        break;
      case 'skewX':
        t = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        t = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, t);
  }
  return m;
};

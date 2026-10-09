#version 300 es
// The distance buffer on the gpu, one fragment per buffer pixel of the current tile: the nearest-edge search of
// src/lib/sdf (bvh.ts, bezier.ts, metrics.ts) ported to float32. Coordinates are relative to the buffer centre in
// pixel units and already mapped into the metric's search space, see src/lib/gpu/pack.ts.
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uNodes; // 2 texels per node: box, (a, b, 0, 0)
uniform sampler2D uEdges; // 3 texels per edge: (x0, y0, x1, y1), (x2, y2, x3, y3), (kind, shape, 0, 0)
uniform sampler2D uInside; // the tile's topmost containing shape per pixel, -1 outside
uniform int uTexWidth; // texels per row of the node and edge textures
uniform ivec2 uSize; // buffer width and height
uniform ivec2 uOffset; // the tile's first pixel
uniform int uSearch; // 0 l2, 1 l1, 2 lp, 3 polygon
uniform mat2 uMatrix;
uniform mat2 uInverse;
uniform float uScale; // world units per search unit
uniform float uPixelSize;
uniform float uP;
uniform int uSides;
uniform vec4 uPolygon[64]; // side normal xy, vertex direction xy
uniform int uEdgeCount;
uniform float uFar;

out vec4 outValue;

const float TIE = 1e-6;
const int SAMPLES = 12;

vec4 fetchData(sampler2D tex, int index) {
  return texelFetch(tex, ivec2(index % uTexWidth, index / uTexWidth), 0);
}

/** the lp norm of (x, y), without overflow for large p */
float lpNorm(vec2 w) {
  vec2 a = abs(w);
  float m = max(a.x, a.y);
  if (m == 0.0) return 0.0;
  float r = min(a.x, a.y) / m;
  return m * pow(1.0 + pow(r, uP), 1.0 / uP);
}

/** the lower bound of the score of every offset in the box lo .. hi */
float rangeScore(vec2 lo, vec2 hi) {
  if (uSearch == 3) {
    float bound = 0.0;
    for (int k = 0; k < 64; k++) {
      if (k >= uSides) break;
      vec2 n = uPolygon[k].xy;
      bound = max(bound, n.x * (n.x > 0.0 ? lo.x : hi.x) + n.y * (n.y > 0.0 ? lo.y : hi.y));
    }
    return bound;
  }
  vec2 d = max(max(lo, vec2(0.0)), -hi);
  if (uSearch == 0) return dot(d, d);
  if (uSearch == 1) return d.x + d.y;
  return lpNorm(d);
}

// ---- shared polynomial helpers --------------------------------------------------------------------------------

/** roots of a t^2 + b t + c in the open interval (0, 1); returns the count, roots in r.x, r.y */
int unitQuadraticRoots(float a, float b, float c, out vec2 r) {
  r = vec2(0.0);
  float scale = max(max(abs(a), abs(b)), abs(c));
  if (scale == 0.0) return 0;
  a /= scale;
  b /= scale;
  c /= scale;
  int n = 0;
  float t0 = -1.0;
  float t1 = -1.0;
  if (abs(a) < 1e-6) {
    if (abs(b) > 1e-6) t0 = -c / b;
  } else {
    float disc = b * b - 4.0 * a * c;
    if (disc >= 0.0) {
      float q = -0.5 * (b + (b < 0.0 ? -1.0 : 1.0) * sqrt(disc));
      t0 = q / a;
      if (q != 0.0) t1 = c / q;
    }
  }
  if (t0 > 1e-6 && t0 < 1.0 - 1e-6) {
    r.x = t0;
    n = 1;
  }
  if (t1 > 1e-6 && t1 < 1.0 - 1e-6) {
    if (n == 0) r.x = t1;
    else r.y = t1;
    n++;
  }
  return n;
}

/** the parameter where a cubic monotone along one axis (power basis a, b, c, v0) reaches value */
float monotoneParameter(float a, float b, float c, float v0, float v3, float value) {
  bool rising = v3 > v0;
  float lo = 0.0;
  float hi = 1.0;
  float t = (value - v0) / (v3 - v0);
  for (int i = 0; i < 40; i++) {
    float f = ((a * t + b) * t + c) * t + v0 - value;
    if ((f > 0.0) == rising) hi = t;
    else lo = t;
    float fp = (3.0 * a * t + 2.0 * b) * t + c;
    float next = fp != 0.0 ? t - f / fp : -1.0;
    if (!(next >= lo && next <= hi)) next = 0.5 * (lo + hi);
    if (abs(next - t) < 1e-7) return next;
    t = next;
  }
  return t;
}

/** all real roots of a t^3 + b t^2 + c t + d in [0, 1], ascending; returns the count */
int cubicRootsInUnit(float a, float b, float c, float d, out vec3 roots) {
  roots = vec3(-1.0);
  float scale = max(max(abs(a), abs(b)), max(abs(c), abs(d)));
  if (scale == 0.0) return 0;
  float tiny = 1e-6 * scale;
  float c1 = 2.0;
  float c2 = 2.0;
  float qa = 3.0 * a;
  float qb = 2.0 * b;
  float qs = max(max(abs(qa), abs(qb)), abs(c));
  if (qs > 0.0) {
    float A = qa / qs;
    float B = qb / qs;
    float C = c / qs;
    if (abs(A) < 1e-6) {
      if (abs(B) > 1e-6) c1 = -C / B;
    } else {
      float disc = B * B - 4.0 * A * C;
      if (disc >= 0.0) {
        float q = -0.5 * (B + (B < 0.0 ? -1.0 : 1.0) * sqrt(disc));
        c1 = q / A;
        c2 = q != 0.0 ? C / q : 2.0;
      }
    }
  }
  if (c2 < c1) {
    float s = c1;
    c1 = c2;
    c2 = s;
  }
  int n = 0;
  float last = -1.0;
  float lo = 0.0;
  float flo = d;
  if (abs(flo) <= tiny) {
    roots.x = 0.0;
    last = 0.0;
    n = 1;
  }
  for (int k = 0; k < 3; k++) {
    float hi = k == 0 ? c1 : (k == 1 ? c2 : 1.0);
    if (!(hi > lo && hi <= 1.0)) continue;
    float fhi = ((a * hi + b) * hi + c) * hi + d;
    float root = -1.0;
    if (abs(fhi) <= tiny) {
      root = hi;
    } else if (abs(flo) > tiny && flo * fhi < 0.0) {
      float l = lo;
      float h = hi;
      float fl = flo;
      float t = 0.5 * (l + h);
      float previous = h - l;
      float lastStep = previous;
      for (int i = 0; i < 40; i++) {
        float v = ((a * t + b) * t + c) * t + d;
        if (v == 0.0) break;
        if (v * fl < 0.0) h = t;
        else {
          l = t;
          fl = v;
        }
        float slope = (3.0 * a * t + 2.0 * b) * t + c;
        float next = slope != 0.0 ? t - v / slope : -1.0;
        if (!(next > l && next < h) || abs(next - t) > 0.5 * previous) next = 0.5 * (l + h);
        previous = lastStep;
        lastStep = abs(next - t);
        if (abs(next - t) < 1e-7) {
          t = next;
          break;
        }
        t = next;
      }
      root = t;
    }
    if (root >= 0.0 && (n == 0 || root - last > 1e-6)) {
      if (n == 0) roots.x = root;
      else if (n == 1) roots.y = root;
      else roots.z = root;
      last = root;
      n++;
    }
    lo = hi;
    flo = fhi;
  }
  return n;
}

// ---- searches: each returns (score, nearest point) -------------------------------------------------------------

vec2 cubicAt(vec2 A, vec2 B, vec2 C, vec2 D, float t) {
  return ((A * t + B) * t + C) * t + D;
}

vec3 nearestL2Line(vec2 a, vec2 b, vec2 q) {
  vec2 e = b - a;
  float len2 = dot(e, e);
  float t = len2 > 0.0 ? clamp(dot(q - a, e) / len2, 0.0, 1.0) : 0.0;
  vec2 p = a + t * e;
  vec2 w = p - q;
  return vec3(dot(w, w), p);
}

vec3 nearestL2Cubic(vec2 A, vec2 B, vec2 C, vec2 P0, vec2 q) {
  vec2 D = P0 - q;
  float d[SAMPLES + 1];
  for (int i = 0; i <= SAMPLES; i++) {
    vec2 e = cubicAt(A, B, C, D, float(i) / float(SAMPLES));
    d[i] = dot(e, e);
  }
  float best = 3.0e38;
  float bestT = 0.0;
  for (int i = 0; i <= SAMPLES; i++) {
    if ((i > 0 && d[i - 1] < d[i]) || (i < SAMPLES && d[i + 1] < d[i])) continue;
    float lo = max(0.0, float(i - 1) / float(SAMPLES));
    float hi = min(1.0, float(i + 1) / float(SAMPLES));
    float t = float(i) / float(SAMPLES);
    for (int k = 0; k < 12; k++) {
      vec2 e = cubicAt(A, B, C, D, t);
      vec2 d1 = (3.0 * A * t + 2.0 * B) * t + C;
      vec2 d2 = 6.0 * A * t + 2.0 * B;
      float f = dot(e, d1);
      float fp = dot(d1, d1) + dot(e, d2);
      if (f > 0.0) hi = t;
      else lo = t;
      float next = fp > 0.0 ? t - f / fp : -1.0;
      if (!(next >= lo && next <= hi)) next = 0.5 * (lo + hi);
      if (abs(next - t) < 1e-7) break;
      t = next;
    }
    vec2 e = cubicAt(A, B, C, D, t);
    float refined = dot(e, e);
    if (refined < best) {
      best = refined;
      bestT = t;
    }
    if (d[i] < best) {
      best = d[i];
      bestT = float(i) / float(SAMPLES);
    }
  }
  return vec3(best, cubicAt(A, B, C, P0, bestT));
}

/** keeps the candidate at parameter t of a line when it is nearer under l1; strict demands a clear margin */
void l1LineCandidate(vec2 a, vec2 e, float t, vec2 q, bool strict, inout vec3 best) {
  if (!(t >= 0.0 && t <= 1.0)) return;
  vec2 p = a + t * e;
  float d = abs(p.x - q.x) + abs(p.y - q.y);
  if (strict ? d < best.x - TIE * (1.0 + abs(best.x)) : d < best.x) best = vec3(d, p);
}

vec3 nearestL1Line(vec2 a, vec2 b, vec2 q) {
  vec2 e = b - a;
  vec3 best = vec3(3.0e38, a);
  float len2 = dot(e, e);
  // the euclidean projection first, it wins ties along 45° lines
  if (len2 > 0.0) l1LineCandidate(a, e, clamp(dot(q - a, e) / len2, 0.0, 1.0), q, false, best);
  l1LineCandidate(a, e, 0.0, q, true, best);
  if (e.x != 0.0) l1LineCandidate(a, e, (q.x - a.x) / e.x, q, true, best);
  if (e.y != 0.0) l1LineCandidate(a, e, (q.y - a.y) / e.y, q, true, best);
  l1LineCandidate(a, e, 1.0, q, true, best);
  return best;
}

vec3 nearestL1Cubic(vec2 A, vec2 B, vec2 C, vec2 P0, vec2 P3, vec2 q) {
  float cand[8];
  int n = 0;
  cand[n++] = 0.0;
  cand[n++] = 1.0;
  if ((q.x - P0.x) * (q.x - P3.x) < 0.0) cand[n++] = monotoneParameter(A.x, B.x, C.x, P0.x, P3.x, q.x);
  if ((q.y - P0.y) * (q.y - P3.y) < 0.0) cand[n++] = monotoneParameter(A.y, B.y, C.y, P0.y, P3.y, q.y);
  vec2 r;
  int m = unitQuadraticRoots(3.0 * (A.x - A.y), 2.0 * (B.x - B.y), C.x - C.y, r);
  if (m > 0) cand[n++] = r.x;
  if (m > 1) cand[n++] = r.y;
  m = unitQuadraticRoots(3.0 * (A.x + A.y), 2.0 * (B.x + B.y), C.x + C.y, r);
  if (m > 0) cand[n++] = r.x;
  if (m > 1) cand[n++] = r.y;
  // ascending, so among equally near points the smallest t wins
  for (int i = 1; i < 8; i++) {
    if (i >= n) break;
    for (int j = i; j > 0; j--) {
      if (cand[j - 1] <= cand[j]) break;
      float s = cand[j];
      cand[j] = cand[j - 1];
      cand[j - 1] = s;
    }
  }
  vec3 best = vec3(3.0e38, P0);
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    vec2 p = cubicAt(A, B, C, P0, cand[i]);
    float d = abs(p.x - q.x) + abs(p.y - q.y);
    if (d < best.x) best = vec3(d, p);
  }
  return best;
}

/** derivative of the lp score along the curve, up to a positive factor, for offsets e and their derivative d1 */
float lpSlope(vec2 e, vec2 d1) {
  vec2 a = abs(e);
  vec2 s = sign(e) * vec2(a.x > 0.0 ? pow(a.x, uP - 1.0) : 0.0, a.y > 0.0 ? pow(a.y, uP - 1.0) : 0.0);
  return dot(s, d1);
}

/**
 * Minimises the lp distance of the cubic (power basis relative to the query) on lo .. hi from t: newton on the
 * derivative inside the bracket with an rtsafe style fallback to bisection. The offsets are normalised by `norm`,
 * which leaves newton steps unchanged and keeps |e|^p in float range.
 */
float refineLp(vec2 A, vec2 B, vec2 C, vec2 D, float lo, float hi, float t, float norm) {
  A /= norm;
  B /= norm;
  C /= norm;
  D /= norm;
  if (lpSlope(cubicAt(A, B, C, D, lo), (3.0 * A * lo + 2.0 * B) * lo + C) >= 0.0) return lo;
  if (lpSlope(cubicAt(A, B, C, D, hi), (3.0 * A * hi + 2.0 * B) * hi + C) <= 0.0) return hi;
  float previous = hi - lo;
  float lastStep = previous;
  for (int i = 0; i < 40; i++) {
    vec2 e = cubicAt(A, B, C, D, t);
    vec2 d1 = (3.0 * A * t + 2.0 * B) * t + C;
    vec2 d2 = 6.0 * A * t + 2.0 * B;
    vec2 a = abs(e);
    vec2 p1 = vec2(a.x > 0.0 ? pow(a.x, uP - 1.0) : 0.0, a.y > 0.0 ? pow(a.y, uP - 1.0) : 0.0);
    vec2 s = sign(e) * p1;
    float g1 = dot(s, d1);
    // |e|^(p-2) is unbounded at a kink for p < 2, newton is then skipped for bisection
    vec2 p2 = vec2(a.x > 0.0 ? p1.x / a.x : (uP >= 2.0 ? 0.0 : 3.0e38), a.y > 0.0 ? p1.y / a.y : (uP >= 2.0 ? 0.0 : 3.0e38));
    float g2 = (uP - 1.0) * (p2.x * d1.x * d1.x + p2.y * d1.y * d1.y) + dot(s, d2);
    if (g1 > 0.0) hi = t;
    else lo = t;
    float next = g2 > 0.0 && g2 < 1.0e37 ? t - g1 / g2 : -1.0;
    if (!(next >= lo && next <= hi) || abs(next - t) > 0.5 * previous) next = 0.5 * (lo + hi);
    previous = lastStep;
    lastStep = abs(next - t);
    if (abs(next - t) < 1e-7 || hi - lo < 1e-7) return next;
    t = next;
  }
  return t;
}

vec3 nearestLp(vec2 A, vec2 B, vec2 C, vec2 P0, bool line, vec2 q) {
  vec2 D = P0 - q;
  // a scale for the offsets, so powers stay in float range during refinement
  float norm = max(max(abs(D.x), abs(D.y)), 1e-6);
  float best = 3.0e38;
  float bestT = 0.0;
  if (line) {
    for (int k = 0; k < 2; k++) {
      float t = float(k);
      float v = lpNorm(cubicAt(A, B, C, D, t));
      if (v < best) {
        best = v;
        bestT = t;
      }
    }
    // the smooth interval between the kinks where the derivative turns positive
    float kx = C.x != 0.0 ? -D.x / C.x : -1.0;
    float ky = C.y != 0.0 ? -D.y / C.y : -1.0;
    float lo = 0.0;
    float hi = 1.0;
    for (int k = 0; k < 2; k++) {
      float kink = (k == 0) == (kx < ky) ? kx : ky;
      if (!(kink > lo && kink < hi)) continue;
      if (lpSlope((C * kink + D) / norm, C / norm) > 0.0) hi = kink;
      else lo = kink;
    }
    float t = refineLp(A, B, C, D, lo, hi, 0.5 * (lo + hi), norm);
    for (int k = 0; k < 3; k++) {
      float u = k == 0 ? lo : (k == 1 ? hi : t);
      float v = lpNorm(cubicAt(A, B, C, D, u));
      if (v < best) {
        best = v;
        bestT = u;
      }
    }
  } else {
    float d[SAMPLES + 1];
    for (int i = 0; i <= SAMPLES; i++) d[i] = lpNorm(cubicAt(A, B, C, D, float(i) / float(SAMPLES)));
    for (int i = 0; i <= SAMPLES; i++) {
      if ((i > 0 && d[i - 1] < d[i]) || (i < SAMPLES && d[i + 1] < d[i])) continue;
      if (d[i] < best) {
        best = d[i];
        bestT = float(i) / float(SAMPLES);
      }
      float lo = max(0.0, float(i - 1) / float(SAMPLES));
      float hi = min(1.0, float(i + 1) / float(SAMPLES));
      float t = refineLp(A, B, C, D, lo, hi, float(i) / float(SAMPLES), norm);
      float v = lpNorm(cubicAt(A, B, C, D, t));
      if (v < best) {
        best = v;
        bestT = t;
      }
    }
  }
  return vec3(best, cubicAt(A, B, C, P0, bestT));
}

/** the polygon gauge of an offset */
float polygonGauge(vec2 w) {
  float f = -3.0e38;
  for (int k = 0; k < 64; k++) {
    if (k >= uSides) break;
    f = max(f, dot(uPolygon[k].xy, w));
  }
  return f;
}

/** keeps the candidate at t when it is nearer under the polygon gauge; the first one is always taken */
void polygonCandidate(vec2 A, vec2 B, vec2 C, vec2 D, float t, bool first, inout vec2 best) {
  float f = polygonGauge(cubicAt(A, B, C, D, t));
  if (first || f < best.x - TIE * (1.0 + abs(best.x))) best = vec2(f, t);
}

vec3 nearestPolygon(vec2 A, vec2 B, vec2 C, vec2 P0, vec2 P1, vec2 P2, vec2 P3, bool line, vec2 q) {
  vec2 D = P0 - q;
  vec2 best = vec2(3.0e38, 0.0); // score, parameter
  if (line) {
    // the euclidean projection first, it wins ties along lines parallel to a side
    float len2 = dot(C, C);
    polygonCandidate(A, B, C, D, len2 > 0.0 ? clamp(-dot(D, C) / len2, 0.0, 1.0) : 0.0, true, best);
    polygonCandidate(A, B, C, D, 0.0, false, best);
    polygonCandidate(A, B, C, D, 1.0, false, best);
    for (int k = 0; k < 64; k++) {
      if (k >= uSides) break;
      vec2 v = uPolygon[k].zw;
      float denom = v.x * C.y - v.y * C.x;
      if (denom == 0.0) continue;
      float t = -(v.x * D.y - v.y * D.x) / denom;
      if (t > 0.0 && t < 1.0) polygonCandidate(A, B, C, D, t, false, best);
    }
  } else {
    polygonCandidate(A, B, C, D, 0.0, true, best);
    polygonCandidate(A, B, C, D, 1.0, false, best);
    vec2 q0 = D;
    vec2 q1 = P1 - q;
    vec2 q2 = P2 - q;
    vec2 q3 = P3 - q;
    for (int k = 0; k < 64; k++) {
      if (k >= uSides) break;
      vec2 v = uPolygon[k].zw;
      // the control points all on one side of the vertex ray: the curve cannot cross it
      vec4 s = vec4(v.x * q0.y - v.y * q0.x, v.x * q1.y - v.y * q1.x, v.x * q2.y - v.y * q2.x, v.x * q3.y - v.y * q3.x);
      if (!(all(greaterThan(s, vec4(0.0))) || all(lessThan(s, vec4(0.0))))) {
        vec3 roots;
        int m = cubicRootsInUnit(v.x * A.y - v.y * A.x, v.x * B.y - v.y * B.x, v.x * C.y - v.y * C.x, v.x * D.y - v.y * D.x, roots);
        if (m > 0) polygonCandidate(A, B, C, D, roots.x, false, best);
        if (m > 1) polygonCandidate(A, B, C, D, roots.y, false, best);
        if (m > 2) polygonCandidate(A, B, C, D, roots.z, false, best);
      }
      // the active side's piece is stationary where n . B' = 0, the hodograph decides whether that can happen
      vec2 nrm = uPolygon[k].xy;
      vec3 h = vec3(dot(nrm, q1 - q0), dot(nrm, q2 - q1), dot(nrm, q3 - q2));
      if (!(all(greaterThan(h, vec3(0.0))) || all(lessThan(h, vec3(0.0))))) {
        vec2 r;
        int m = unitQuadraticRoots(3.0 * dot(nrm, A), 2.0 * dot(nrm, B), dot(nrm, C), r);
        if (m > 0) polygonCandidate(A, B, C, D, r.x, false, best);
        if (m > 1) polygonCandidate(A, B, C, D, r.y, false, best);
      }
    }
  }
  return vec3(best.x, cubicAt(A, B, C, P0, best.y));
}

// ---- the search ------------------------------------------------------------------------------------------------

vec3 bestHit; // score, nearest point
float bestShape;

void testEdge(int e, vec2 q) {
  vec4 e0 = fetchData(uEdges, e * 3);
  vec4 e1 = fetchData(uEdges, e * 3 + 1);
  vec4 e2 = fetchData(uEdges, e * 3 + 2);
  vec2 P0 = e0.xy;
  vec2 P1 = e0.zw;
  vec2 P2 = e1.xy;
  vec2 P3 = e1.zw;
  bool line = e2.x == 0.0;
  // skip the search when the control point box cannot win
  vec2 lo = min(min(P0, P1), min(P2, P3)) - q;
  vec2 hi = max(max(P0, P1), max(P2, P3)) - q;
  if (rangeScore(lo, hi) >= bestHit.x) return;
  vec2 A = -P0 + 3.0 * P1 - 3.0 * P2 + P3;
  vec2 B = 3.0 * P0 - 6.0 * P1 + 3.0 * P2;
  vec2 C = 3.0 * (P1 - P0);
  if (line) {
    A = vec2(0.0);
    B = vec2(0.0);
    C = P3 - P0;
  }
  vec3 hit;
  if (uSearch == 0) hit = line ? nearestL2Line(P0, P3, q) : nearestL2Cubic(A, B, C, P0, q);
  else if (uSearch == 1) hit = line ? nearestL1Line(P0, P3, q) : nearestL1Cubic(A, B, C, P0, P3, q);
  else if (uSearch == 2) hit = nearestLp(A, B, C, P0, line, q);
  else hit = nearestPolygon(A, B, C, P0, P1, P2, P3, line, q);
  if (hit.x < bestHit.x) {
    bestHit = hit;
    bestShape = e2.y;
  }
}

float nodeScore(int node, vec2 q) {
  vec4 box = fetchData(uNodes, node * 2);
  return rangeScore(box.xy - q, box.zw - q);
}

void main() {
  ivec2 local = ivec2(gl_FragCoord.xy);
  float insideId = texelFetch(uInside, local, 0).r;
  if (uEdgeCount == 0) {
    outValue = vec4(uFar, 0.0, 0.0, -1.0);
    return;
  }
  ivec2 pixel = local + uOffset;
  vec2 q = uMatrix * (vec2(pixel) + 0.5 - 0.5 * vec2(uSize));

  bestHit = vec3(3.0e38, 0.0, 0.0);
  bestShape = -1.0;
  int stack[64];
  int top = 0;
  stack[top++] = 0;
  for (int guard = 0; guard < 1000000; guard++) {
    if (top == 0) break;
    int node = stack[--top];
    if (nodeScore(node, q) >= bestHit.x) continue;
    vec4 ab = fetchData(uNodes, node * 2 + 1);
    int a = int(ab.x);
    int b = int(ab.y);
    if (b > 0) {
      for (int i = 0; i < 4; i++) {
        if (i >= b) break;
        testEdge(a + i, q);
      }
      continue;
    }
    int l = a;
    int r = -b - 1;
    float dl = nodeScore(l, q);
    float dr = nodeScore(r, q);
    // the farther child first, so the nearer one is searched first
    if (dl < dr) {
      if (dr < bestHit.x && top < 64) stack[top++] = r;
      if (dl < bestHit.x && top < 64) stack[top++] = l;
    } else {
      if (dl < bestHit.x && top < 64) stack[top++] = l;
      if (dr < bestHit.x && top < 64) stack[top++] = r;
    }
  }

  float base = uSearch == 0 ? sqrt(bestHit.x) : bestHit.x;
  float distance = base * uScale;
  vec2 v = (uInverse * (bestHit.yz - q)) * uPixelSize;
  bool inside = insideId >= 0.0;
  outValue = vec4(inside ? -distance : distance, v, inside ? insideId : bestShape);
}

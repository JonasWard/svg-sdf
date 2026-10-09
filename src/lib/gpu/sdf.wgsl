// The distance buffer on the gpu as a webgpu compute shader, one invocation per buffer pixel of the current tile.
// A line by line port of sdf.frag.glsl, which in turn ports the nearest-edge search of src/lib/sdf to float32.
// Coordinates are relative to the buffer centre in pixel units, mapped into the metric's search space (gpu/pack.ts).

struct Params {
  matrix: mat2x2<f32>,
  inverse: mat2x2<f32>,
  size: vec2<i32>, // buffer width and height
  offset: vec2<i32>, // the tile's first pixel
  tile: vec2<i32>, // the tile's width and height
  search: i32, // 0 l2, 1 l1, 2 lp, 3 polygon
  sides: i32,
  edgeCount: i32,
  scale: f32, // world units per search unit
  pixelSize: f32,
  p: f32,
  far: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> nodes: array<vec4<f32>>; // 2 per node: box, (a, b, 0, 0)
@group(0) @binding(2) var<storage, read> edges: array<vec4<f32>>; // 3 per edge: P0 P1, P2 P3, (kind, shape, 0, 0)
@group(0) @binding(3) var<storage, read> inside: array<f32>; // the tile's topmost containing shape, -1 outside
@group(0) @binding(4) var<storage, read> polygon: array<vec4<f32>>; // side normal xy, vertex direction xy
@group(0) @binding(5) var<storage, read_write> result: array<vec4<f32>>;

const TIE: f32 = 1e-6;
const SAMPLES: i32 = 12;
const BIG: f32 = 3.0e38;

fn lpNorm(w: vec2<f32>) -> f32 {
  let a = abs(w);
  let m = max(a.x, a.y);
  if (m == 0.0) { return 0.0; }
  let r = min(a.x, a.y) / m;
  return m * pow(1.0 + pow(r, params.p), 1.0 / params.p);
}

fn rangeScore(lo: vec2<f32>, hi: vec2<f32>) -> f32 {
  if (params.search == 3) {
    var bound = 0.0;
    for (var k = 0; k < params.sides; k++) {
      let n = polygon[k].xy;
      bound = max(bound, n.x * select(hi.x, lo.x, n.x > 0.0) + n.y * select(hi.y, lo.y, n.y > 0.0));
    }
    return bound;
  }
  let d = max(max(lo, vec2<f32>(0.0)), -hi);
  if (params.search == 0) { return dot(d, d); }
  if (params.search == 1) { return d.x + d.y; }
  return lpNorm(d);
}

// ---- shared polynomial helpers ----------------------------------------------------------------------------------

struct Roots2 { n: i32, r: vec2<f32> }

fn unitQuadraticRoots(a0: f32, b0: f32, c0: f32) -> Roots2 {
  var out = Roots2(0, vec2<f32>(0.0));
  let scale = max(max(abs(a0), abs(b0)), abs(c0));
  if (scale == 0.0) { return out; }
  let a = a0 / scale;
  let b = b0 / scale;
  let c = c0 / scale;
  var t0 = -1.0;
  var t1 = -1.0;
  if (abs(a) < 1e-6) {
    if (abs(b) > 1e-6) { t0 = -c / b; }
  } else {
    let disc = b * b - 4.0 * a * c;
    if (disc >= 0.0) {
      let q = -0.5 * (b + select(1.0, -1.0, b < 0.0) * sqrt(disc));
      t0 = q / a;
      if (q != 0.0) { t1 = c / q; }
    }
  }
  if (t0 > 1e-6 && t0 < 1.0 - 1e-6) {
    out.r.x = t0;
    out.n = 1;
  }
  if (t1 > 1e-6 && t1 < 1.0 - 1e-6) {
    if (out.n == 0) { out.r.x = t1; } else { out.r.y = t1; }
    out.n = out.n + 1;
  }
  return out;
}

fn monotoneParameter(a: f32, b: f32, c: f32, v0: f32, v3: f32, value: f32) -> f32 {
  let rising = v3 > v0;
  var lo = 0.0;
  var hi = 1.0;
  var t = (value - v0) / (v3 - v0);
  for (var i = 0; i < 40; i++) {
    let f = ((a * t + b) * t + c) * t + v0 - value;
    if ((f > 0.0) == rising) { hi = t; } else { lo = t; }
    let fp = (3.0 * a * t + 2.0 * b) * t + c;
    var next = select(-1.0, t - f / fp, fp != 0.0);
    if (!(next >= lo && next <= hi)) { next = 0.5 * (lo + hi); }
    if (abs(next - t) < 1e-7) { return next; }
    t = next;
  }
  return t;
}

struct Roots3 { n: i32, r: vec3<f32> }

fn cubicRootsInUnit(a: f32, b: f32, c: f32, d: f32) -> Roots3 {
  var out = Roots3(0, vec3<f32>(-1.0));
  let scale = max(max(abs(a), abs(b)), max(abs(c), abs(d)));
  if (scale == 0.0) { return out; }
  let tiny = 1e-6 * scale;
  var c1 = 2.0;
  var c2 = 2.0;
  let qa = 3.0 * a;
  let qb = 2.0 * b;
  let qs = max(max(abs(qa), abs(qb)), abs(c));
  if (qs > 0.0) {
    let A = qa / qs;
    let B = qb / qs;
    let C = c / qs;
    if (abs(A) < 1e-6) {
      if (abs(B) > 1e-6) { c1 = -C / B; }
    } else {
      let disc = B * B - 4.0 * A * C;
      if (disc >= 0.0) {
        let q = -0.5 * (B + select(1.0, -1.0, B < 0.0) * sqrt(disc));
        c1 = q / A;
        c2 = select(2.0, C / q, q != 0.0);
      }
    }
  }
  if (c2 < c1) {
    let s = c1;
    c1 = c2;
    c2 = s;
  }
  var last = -1.0;
  var lo = 0.0;
  var flo = d;
  if (abs(flo) <= tiny) {
    out.r.x = 0.0;
    last = 0.0;
    out.n = 1;
  }
  for (var k = 0; k < 3; k++) {
    var hi = 1.0;
    if (k == 0) { hi = c1; } else if (k == 1) { hi = c2; }
    if (!(hi > lo && hi <= 1.0)) { continue; }
    let fhi = ((a * hi + b) * hi + c) * hi + d;
    var root = -1.0;
    if (abs(fhi) <= tiny) {
      root = hi;
    } else if (abs(flo) > tiny && flo * fhi < 0.0) {
      var l = lo;
      var h = hi;
      var fl = flo;
      var t = 0.5 * (l + h);
      var previous = h - l;
      var lastStep = previous;
      for (var i = 0; i < 40; i++) {
        let v = ((a * t + b) * t + c) * t + d;
        if (v == 0.0) { break; }
        if (v * fl < 0.0) { h = t; } else {
          l = t;
          fl = v;
        }
        let slope = (3.0 * a * t + 2.0 * b) * t + c;
        var next = select(-1.0, t - v / slope, slope != 0.0);
        if (!(next > l && next < h) || abs(next - t) > 0.5 * previous) { next = 0.5 * (l + h); }
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
    if (root >= 0.0 && (out.n == 0 || root - last > 1e-6)) {
      if (out.n == 0) { out.r.x = root; } else if (out.n == 1) { out.r.y = root; } else { out.r.z = root; }
      last = root;
      out.n = out.n + 1;
    }
    lo = hi;
    flo = fhi;
  }
  return out;
}

// ---- searches: each returns (score, nearest point) -------------------------------------------------------------

fn cubicAt(A: vec2<f32>, B: vec2<f32>, C: vec2<f32>, D: vec2<f32>, t: f32) -> vec2<f32> {
  return ((A * t + B) * t + C) * t + D;
}

fn nearestL2Line(a: vec2<f32>, b: vec2<f32>, q: vec2<f32>) -> vec3<f32> {
  let e = b - a;
  let len2 = dot(e, e);
  let t = select(0.0, clamp(dot(q - a, e) / len2, 0.0, 1.0), len2 > 0.0);
  let p = a + t * e;
  let w = p - q;
  return vec3<f32>(dot(w, w), p);
}

fn nearestL2Cubic(A: vec2<f32>, B: vec2<f32>, C: vec2<f32>, P0: vec2<f32>, q: vec2<f32>) -> vec3<f32> {
  let D = P0 - q;
  var d: array<f32, 13>;
  for (var i = 0; i <= SAMPLES; i++) {
    let e = cubicAt(A, B, C, D, f32(i) / f32(SAMPLES));
    d[i] = dot(e, e);
  }
  var best = BIG;
  var bestT = 0.0;
  for (var i = 0; i <= SAMPLES; i++) {
    if (i > 0 && d[i - 1] < d[i]) { continue; }
    if (i < SAMPLES && d[min(i + 1, SAMPLES)] < d[i]) { continue; }
    var lo = max(0.0, f32(i - 1) / f32(SAMPLES));
    var hi = min(1.0, f32(i + 1) / f32(SAMPLES));
    var t = f32(i) / f32(SAMPLES);
    for (var k = 0; k < 12; k++) {
      let e = cubicAt(A, B, C, D, t);
      let d1 = (3.0 * A * t + 2.0 * B) * t + C;
      let d2 = 6.0 * A * t + 2.0 * B;
      let f = dot(e, d1);
      let fp = dot(d1, d1) + dot(e, d2);
      if (f > 0.0) { hi = t; } else { lo = t; }
      var next = select(-1.0, t - f / fp, fp > 0.0);
      if (!(next >= lo && next <= hi)) { next = 0.5 * (lo + hi); }
      if (abs(next - t) < 1e-7) { break; }
      t = next;
    }
    let e = cubicAt(A, B, C, D, t);
    let refined = dot(e, e);
    if (refined < best) {
      best = refined;
      bestT = t;
    }
    if (d[i] < best) {
      best = d[i];
      bestT = f32(i) / f32(SAMPLES);
    }
  }
  return vec3<f32>(best, cubicAt(A, B, C, P0, bestT));
}

fn l1LineCandidate(a: vec2<f32>, e: vec2<f32>, t: f32, q: vec2<f32>, strict: bool, best: vec3<f32>) -> vec3<f32> {
  if (!(t >= 0.0 && t <= 1.0)) { return best; }
  let p = a + t * e;
  let d = abs(p.x - q.x) + abs(p.y - q.y);
  let better = select(d < best.x, d < best.x - TIE * (1.0 + abs(best.x)), strict);
  return select(best, vec3<f32>(d, p), better);
}

fn nearestL1Line(a: vec2<f32>, b: vec2<f32>, q: vec2<f32>) -> vec3<f32> {
  let e = b - a;
  var best = vec3<f32>(BIG, a);
  let len2 = dot(e, e);
  if (len2 > 0.0) { best = l1LineCandidate(a, e, clamp(dot(q - a, e) / len2, 0.0, 1.0), q, false, best); }
  best = l1LineCandidate(a, e, 0.0, q, true, best);
  if (e.x != 0.0) { best = l1LineCandidate(a, e, (q.x - a.x) / e.x, q, true, best); }
  if (e.y != 0.0) { best = l1LineCandidate(a, e, (q.y - a.y) / e.y, q, true, best); }
  best = l1LineCandidate(a, e, 1.0, q, true, best);
  return best;
}

fn nearestL1Cubic(A: vec2<f32>, B: vec2<f32>, C: vec2<f32>, P0: vec2<f32>, P3: vec2<f32>, q: vec2<f32>) -> vec3<f32> {
  var cand: array<f32, 8>;
  var n = 0;
  cand[0] = 0.0;
  cand[1] = 1.0;
  n = 2;
  if ((q.x - P0.x) * (q.x - P3.x) < 0.0) {
    cand[n] = monotoneParameter(A.x, B.x, C.x, P0.x, P3.x, q.x);
    n = n + 1;
  }
  if ((q.y - P0.y) * (q.y - P3.y) < 0.0) {
    cand[n] = monotoneParameter(A.y, B.y, C.y, P0.y, P3.y, q.y);
    n = n + 1;
  }
  let r1 = unitQuadraticRoots(3.0 * (A.x - A.y), 2.0 * (B.x - B.y), C.x - C.y);
  if (r1.n > 0) { cand[n] = r1.r.x; n = n + 1; }
  if (r1.n > 1) { cand[n] = r1.r.y; n = n + 1; }
  let r2 = unitQuadraticRoots(3.0 * (A.x + A.y), 2.0 * (B.x + B.y), C.x + C.y);
  if (r2.n > 0) { cand[n] = r2.r.x; n = n + 1; }
  if (r2.n > 1) { cand[n] = r2.r.y; n = n + 1; }
  // ascending, so among equally near points the smallest t wins
  for (var i = 1; i < n; i++) {
    var j = i;
    loop {
      if (j == 0 || cand[j - 1] <= cand[j]) { break; }
      let s = cand[j];
      cand[j] = cand[j - 1];
      cand[j - 1] = s;
      j = j - 1;
    }
  }
  var best = vec3<f32>(BIG, P0);
  for (var i = 0; i < n; i++) {
    let p = cubicAt(A, B, C, P0, cand[i]);
    let d = abs(p.x - q.x) + abs(p.y - q.y);
    if (d < best.x) { best = vec3<f32>(d, p); }
  }
  return best;
}

fn powAbs(v: vec2<f32>, e: f32) -> vec2<f32> {
  let a = abs(v);
  return vec2<f32>(select(0.0, pow(a.x, e), a.x > 0.0), select(0.0, pow(a.y, e), a.y > 0.0));
}

fn lpSlope(e: vec2<f32>, d1: vec2<f32>) -> f32 {
  return dot(sign(e) * powAbs(e, params.p - 1.0), d1);
}

fn refineLp(A0: vec2<f32>, B0: vec2<f32>, C0: vec2<f32>, D0: vec2<f32>, lo0: f32, hi0: f32, t0: f32, norm: f32) -> f32 {
  let A = A0 / norm;
  let B = B0 / norm;
  let C = C0 / norm;
  let D = D0 / norm;
  var lo = lo0;
  var hi = hi0;
  var t = t0;
  if (lpSlope(cubicAt(A, B, C, D, lo), (3.0 * A * lo + 2.0 * B) * lo + C) >= 0.0) { return lo; }
  if (lpSlope(cubicAt(A, B, C, D, hi), (3.0 * A * hi + 2.0 * B) * hi + C) <= 0.0) { return hi; }
  var previous = hi - lo;
  var lastStep = previous;
  for (var i = 0; i < 40; i++) {
    let e = cubicAt(A, B, C, D, t);
    let d1 = (3.0 * A * t + 2.0 * B) * t + C;
    let d2 = 6.0 * A * t + 2.0 * B;
    let a = abs(e);
    let p1 = powAbs(e, params.p - 1.0);
    let s = sign(e) * p1;
    let g1 = dot(s, d1);
    let unbounded = select(BIG, 0.0, params.p >= 2.0);
    let p2 = vec2<f32>(select(unbounded, p1.x / a.x, a.x > 0.0), select(unbounded, p1.y / a.y, a.y > 0.0));
    let g2 = (params.p - 1.0) * (p2.x * d1.x * d1.x + p2.y * d1.y * d1.y) + dot(s, d2);
    if (g1 > 0.0) { hi = t; } else { lo = t; }
    var next = select(-1.0, t - g1 / g2, g2 > 0.0 && g2 < 1.0e37);
    if (!(next >= lo && next <= hi) || abs(next - t) > 0.5 * previous) { next = 0.5 * (lo + hi); }
    previous = lastStep;
    lastStep = abs(next - t);
    if (abs(next - t) < 1e-7 || hi - lo < 1e-7) { return next; }
    t = next;
  }
  return t;
}

fn nearestLp(A: vec2<f32>, B: vec2<f32>, C: vec2<f32>, P0: vec2<f32>, line: bool, q: vec2<f32>) -> vec3<f32> {
  let D = P0 - q;
  let norm = max(max(abs(D.x), abs(D.y)), 1e-6);
  var best = BIG;
  var bestT = 0.0;
  if (line) {
    for (var k = 0; k < 2; k++) {
      let v = lpNorm(cubicAt(A, B, C, D, f32(k)));
      if (v < best) {
        best = v;
        bestT = f32(k);
      }
    }
    let kx = select(-1.0, -D.x / C.x, C.x != 0.0);
    let ky = select(-1.0, -D.y / C.y, C.y != 0.0);
    var lo = 0.0;
    var hi = 1.0;
    for (var k = 0; k < 2; k++) {
      let kink = select(ky, kx, (k == 0) == (kx < ky));
      if (!(kink > lo && kink < hi)) { continue; }
      if (lpSlope((C * kink + D) / norm, C / norm) > 0.0) { hi = kink; } else { lo = kink; }
    }
    let t = refineLp(A, B, C, D, lo, hi, 0.5 * (lo + hi), norm);
    for (var k = 0; k < 3; k++) {
      var u = t;
      if (k == 0) { u = lo; } else if (k == 1) { u = hi; }
      let v = lpNorm(cubicAt(A, B, C, D, u));
      if (v < best) {
        best = v;
        bestT = u;
      }
    }
  } else {
    var d: array<f32, 13>;
    for (var i = 0; i <= SAMPLES; i++) { d[i] = lpNorm(cubicAt(A, B, C, D, f32(i) / f32(SAMPLES))); }
    for (var i = 0; i <= SAMPLES; i++) {
      if (i > 0 && d[i - 1] < d[i]) { continue; }
      if (i < SAMPLES && d[min(i + 1, SAMPLES)] < d[i]) { continue; }
      if (d[i] < best) {
        best = d[i];
        bestT = f32(i) / f32(SAMPLES);
      }
      let lo = max(0.0, f32(i - 1) / f32(SAMPLES));
      let hi = min(1.0, f32(i + 1) / f32(SAMPLES));
      let t = refineLp(A, B, C, D, lo, hi, f32(i) / f32(SAMPLES), norm);
      let v = lpNorm(cubicAt(A, B, C, D, t));
      if (v < best) {
        best = v;
        bestT = t;
      }
    }
  }
  return vec3<f32>(best, cubicAt(A, B, C, P0, bestT));
}

fn polygonGauge(w: vec2<f32>) -> f32 {
  var f = -BIG;
  for (var k = 0; k < params.sides; k++) { f = max(f, dot(polygon[k].xy, w)); }
  return f;
}

fn polygonCandidate(A: vec2<f32>, B: vec2<f32>, C: vec2<f32>, D: vec2<f32>, t: f32, first: bool, best: vec2<f32>) -> vec2<f32> {
  let f = polygonGauge(cubicAt(A, B, C, D, t));
  return select(best, vec2<f32>(f, t), first || f < best.x - TIE * (1.0 + abs(best.x)));
}

fn nearestPolygon(A: vec2<f32>, B: vec2<f32>, C: vec2<f32>, P0: vec2<f32>, P1: vec2<f32>, P2: vec2<f32>, P3: vec2<f32>, line: bool, q: vec2<f32>) -> vec3<f32> {
  let D = P0 - q;
  var best = vec2<f32>(BIG, 0.0);
  if (line) {
    let len2 = dot(C, C);
    best = polygonCandidate(A, B, C, D, select(0.0, clamp(-dot(D, C) / len2, 0.0, 1.0), len2 > 0.0), true, best);
    best = polygonCandidate(A, B, C, D, 0.0, false, best);
    best = polygonCandidate(A, B, C, D, 1.0, false, best);
    for (var k = 0; k < params.sides; k++) {
      let v = polygon[k].zw;
      let denom = v.x * C.y - v.y * C.x;
      if (denom == 0.0) { continue; }
      let t = -(v.x * D.y - v.y * D.x) / denom;
      if (t > 0.0 && t < 1.0) { best = polygonCandidate(A, B, C, D, t, false, best); }
    }
  } else {
    best = polygonCandidate(A, B, C, D, 0.0, true, best);
    best = polygonCandidate(A, B, C, D, 1.0, false, best);
    let q0 = D;
    let q1 = P1 - q;
    let q2 = P2 - q;
    let q3 = P3 - q;
    for (var k = 0; k < params.sides; k++) {
      let v = polygon[k].zw;
      let s = vec4<f32>(v.x * q0.y - v.y * q0.x, v.x * q1.y - v.y * q1.x, v.x * q2.y - v.y * q2.x, v.x * q3.y - v.y * q3.x);
      if (!(all(s > vec4<f32>(0.0)) || all(s < vec4<f32>(0.0)))) {
        let roots = cubicRootsInUnit(v.x * A.y - v.y * A.x, v.x * B.y - v.y * B.x, v.x * C.y - v.y * C.x, v.x * D.y - v.y * D.x);
        if (roots.n > 0) { best = polygonCandidate(A, B, C, D, roots.r.x, false, best); }
        if (roots.n > 1) { best = polygonCandidate(A, B, C, D, roots.r.y, false, best); }
        if (roots.n > 2) { best = polygonCandidate(A, B, C, D, roots.r.z, false, best); }
      }
      let nrm = polygon[k].xy;
      let h = vec3<f32>(dot(nrm, q1 - q0), dot(nrm, q2 - q1), dot(nrm, q3 - q2));
      if (!(all(h > vec3<f32>(0.0)) || all(h < vec3<f32>(0.0)))) {
        let r = unitQuadraticRoots(3.0 * dot(nrm, A), 2.0 * dot(nrm, B), dot(nrm, C));
        if (r.n > 0) { best = polygonCandidate(A, B, C, D, r.r.x, false, best); }
        if (r.n > 1) { best = polygonCandidate(A, B, C, D, r.r.y, false, best); }
      }
    }
  }
  return vec3<f32>(best.x, cubicAt(A, B, C, P0, best.y));
}

// ---- the search ------------------------------------------------------------------------------------------------

var<private> bestHit: vec3<f32>;
var<private> bestShape: f32;

fn testEdge(e: i32, q: vec2<f32>) {
  let e0 = edges[e * 3];
  let e1 = edges[e * 3 + 1];
  let e2 = edges[e * 3 + 2];
  let P0 = e0.xy;
  let P1 = e0.zw;
  let P2 = e1.xy;
  let P3 = e1.zw;
  let line = e2.x == 0.0;
  let lo = min(min(P0, P1), min(P2, P3)) - q;
  let hi = max(max(P0, P1), max(P2, P3)) - q;
  if (rangeScore(lo, hi) >= bestHit.x) { return; }
  var A = -P0 + 3.0 * P1 - 3.0 * P2 + P3;
  var B = 3.0 * P0 - 6.0 * P1 + 3.0 * P2;
  var C = 3.0 * (P1 - P0);
  if (line) {
    A = vec2<f32>(0.0);
    B = vec2<f32>(0.0);
    C = P3 - P0;
  }
  var hit: vec3<f32>;
  if (params.search == 0) {
    if (line) { hit = nearestL2Line(P0, P3, q); } else { hit = nearestL2Cubic(A, B, C, P0, q); }
  } else if (params.search == 1) {
    if (line) { hit = nearestL1Line(P0, P3, q); } else { hit = nearestL1Cubic(A, B, C, P0, P3, q); }
  } else if (params.search == 2) {
    hit = nearestLp(A, B, C, P0, line, q);
  } else {
    hit = nearestPolygon(A, B, C, P0, P1, P2, P3, line, q);
  }
  if (hit.x < bestHit.x) {
    bestHit = hit;
    bestShape = e2.y;
  }
}

fn nodeScore(node: i32, q: vec2<f32>) -> f32 {
  let box = nodes[node * 2];
  return rangeScore(box.xy - q, box.zw - q);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let local = vec2<i32>(gid.xy);
  if (local.x >= params.tile.x || local.y >= params.tile.y) { return; }
  let index = local.y * params.tile.x + local.x;
  let insideId = inside[index];
  if (params.edgeCount == 0) {
    result[index] = vec4<f32>(params.far, 0.0, 0.0, -1.0);
    return;
  }
  let pixel = local + params.offset;
  let q = params.matrix * (vec2<f32>(pixel) + 0.5 - 0.5 * vec2<f32>(params.size));

  bestHit = vec3<f32>(BIG, 0.0, 0.0);
  bestShape = -1.0;
  var stack: array<i32, 64>;
  var top = 1;
  stack[0] = 0;
  loop {
    if (top == 0) { break; }
    top = top - 1;
    let node = stack[top];
    if (nodeScore(node, q) >= bestHit.x) { continue; }
    let ab = nodes[node * 2 + 1];
    let a = i32(ab.x);
    let b = i32(ab.y);
    if (b > 0) {
      for (var i = 0; i < b; i++) { testEdge(a + i, q); }
      continue;
    }
    let l = a;
    let r = -b - 1;
    let dl = nodeScore(l, q);
    let dr = nodeScore(r, q);
    if (dl < dr) {
      if (dr < bestHit.x && top < 64) { stack[top] = r; top = top + 1; }
      if (dl < bestHit.x && top < 64) { stack[top] = l; top = top + 1; }
    } else {
      if (dl < bestHit.x && top < 64) { stack[top] = l; top = top + 1; }
      if (dr < bestHit.x && top < 64) { stack[top] = r; top = top + 1; }
    }
  }

  let base = select(bestHit.x, sqrt(bestHit.x), params.search == 0);
  let distance = base * params.scale;
  let v = (params.inverse * (bestHit.yz - q)) * params.pixelSize;
  let isInside = insideId >= 0.0;
  result[index] = vec4<f32>(select(distance, -distance, isInside), v, select(bestShape, insideId, isInside));
}

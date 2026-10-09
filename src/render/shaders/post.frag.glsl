#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

// distance buffer: signed distance, vector to the nearest edge point (x, y), shape id
uniform sampler2D uSdf;
uniform ivec2 uSdfSize;
uniform vec4 uRegion; // minX, minY, maxX, maxY in world units
uniform float uPixelSize;
// rows 0 (inside ramp), 1 (outside ramp) and 2 (cyclic polar gradient), 256 samples each, repeating along s
uniform sampler2D uRamp;
// colour per shape id, uColorsWidth wide
uniform sampler2D uColors;
uniform int uColorsWidth;

uniform vec2 uViewport; // device px
uniform vec2 uCenter; // world position at the viewport centre
uniform float uScale; // world units per device px
uniform float uDevicePixelRatio; // device px per css px, line widths are given in css px

uniform int uMode; // 0 ramp, 1 polar, 2 shape, 3 grayscale
uniform vec3 uBackground;

uniform vec2 uRampRange; // inside, outside, world units
uniform bool uRampRepeat;

uniform float uPolarRepetitions;
uniform float uHueOffset;
uniform float uPolarRange;
uniform vec4 uPolarInside; // sat near, sat far, value near, value far
uniform vec4 uPolarOutside;
uniform float uRadialLines;
uniform float uRadialWidth;
uniform int uPolarPalette; // 0 hsv, 1 oklch, 2 cyclic gradient
uniform bool uTiles;
uniform bool uTilesMosaic;
uniform float uTileAngleBands;
uniform float uTileSpacing; // world units
uniform float uTileContrast;

uniform int uMetric; // 0 euclidean, 1 manhattan, 2 chebyshev

uniform float uShapeRange;
uniform float uShadeInside;
uniform float uFadeOutside;

uniform float uGrayRange;

uniform bool uContours;
uniform bool uContourBands;
uniform float uContourSpacing;
uniform float uContourOffset;
uniform float uContourWidth;
uniform vec3 uContourColor;
uniform float uContourOpacity;
uniform bvec2 uContourSides; // inside, outside

uniform bool uOutline;
uniform float uOutlineWidth;
uniform vec3 uOutlineColor;

out vec4 outColor;

const float TAU = 6.28318530718;

vec4 texel(ivec2 p) {
  vec4 v = texelFetch(uSdf, clamp(p, ivec2(0), uSdfSize - 1), 0);
  // turn the vector to the nearest point into the field gradient, which points away from the shape on both sides,
  // so it interpolates smoothly across the edge
  v.yz *= v.x < 0.0 ? 1.0 : -1.0;
  return v;
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

/** oklch (lightness 0..1, chroma, hue in radians) to gamma encoded srgb, clamped to the gamut */
vec3 oklch2srgb(float L, float C, float h) {
  float a = C * cos(h);
  float b = C * sin(h);
  float l = L + 0.3963377774 * a + 0.2158037573 * b;
  float m = L - 0.1055613458 * a - 0.0638541728 * b;
  float s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  vec3 lin = vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
  lin = clamp(lin, 0.0, 1.0);
  return mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}

/** the polar colour for a hue in 0..1 and the near (0) to far (1) blend of one side's settings */
vec3 polarColor(float hue, float k, vec4 side) {
  float saturation = mix(side.x, side.y, k);
  float value = mix(side.z, side.w, k);
  // oklch: saturation drives chroma and value drives lightness, so equal settings give equal perceived brightness
  if (uPolarPalette == 1) return oklch2srgb(value, saturation * 0.15, hue * TAU);
  // hsv and the gradient share the hsv formula: saturation blends from white, value scales
  vec3 base = uPolarPalette == 2 ? texture(uRamp, vec2(hue, 5.0 / 6.0)).rgb : hsv2rgb(vec3(hue, 1.0, 1.0));
  return value * mix(vec3(1.0), base, saturation);
}

/**
 * Distance in device px to the nearest integer of a coordinate u that may wrap. Far away where u does not vary
 * (next to a straight edge) or jumps by more than half a step between pixels (on a ridge between two edges),
 * neither of which is a line or tile edge.
 */
float wrappedLineDistancePx(float u) {
  float du = min(fwidth(u), fwidth(fract(u + 0.5)));
  float a = fract(u);
  return du > 1e-9 && du < 0.5 ? min(a, 1.0 - a) / du : 1e9;
}

/** coverage of a line of `width` px, given the distance to its centre line in px */
float line(float distancePx, float width) {
  return 1.0 - smoothstep(width * 0.5 - 0.5, width * 0.5 + 0.5, distancePx);
}

void main() {
  vec2 frag = gl_FragCoord.xy - 0.5 * uViewport;
  // world y points down like in svg
  vec2 world = uCenter + vec2(frag.x, -frag.y) * uScale;
  if (any(lessThan(world, uRegion.xy)) || any(greaterThan(world, uRegion.zw))) {
    outColor = vec4(uBackground, 1.0);
    return;
  }

  // manual bilinear filtering, float textures are not filterable everywhere
  vec2 t = (world - uRegion.xy) / uPixelSize - 0.5;
  ivec2 i0 = ivec2(floor(t));
  vec2 f = t - floor(t);
  vec4 s = mix(mix(texel(i0), texel(i0 + ivec2(1, 0)), f.x), mix(texel(i0 + ivec2(0, 1)), texel(i0 + ivec2(1, 1)), f.x), f.y);
  float d = s.x;
  vec2 gradient = s.yz;
  int shape = int(texel(ivec2(floor(t + 0.5))).w + 0.5);
  bool inside = d < 0.0;
  float px = uScale;
  // how fast the distance grows per world unit: 1, except for manhattan where the nearest point lies diagonally
  float slope = 1.0;
  if (uMetric == 1) slope = max(1.0, length(sign(texel(ivec2(floor(t + 0.5))).yz)));
  // world units per unit of distance, per device px
  float pxD = px * slope;

  vec3 color;
  if (uMode == 0) {
    float range = inside ? uRampRange.x : uRampRange.y;
    float r = abs(d) / max(range, 1e-6);
    r = uRampRepeat ? fract(r) : clamp(r, 0.0, 1.0);
    color = texture(uRamp, vec2((r * 255.0 + 0.5) / 256.0, inside ? 1.0 / 6.0 : 0.5)).rgb;
  } else if (uMode == 1) {
    float angle = fract(atan(gradient.y, gradient.x) / TAU);
    float dist = abs(d);
    float spacing = max(uTileSpacing, 1e-6);
    if (uTiles && uTilesMosaic) {
      // every tile of the (angle x distance) plane takes the colour of its centre
      angle = (floor(angle * uTileAngleBands) + 0.5) / uTileAngleBands;
      dist = (floor(dist / spacing) + 0.5) * spacing;
    }
    float hue = fract(angle * uPolarRepetitions + uHueOffset);
    float k = 1.0 - exp(-dist / max(uPolarRange, 1e-6));
    color = polarColor(hue, k, inside ? uPolarInside : uPolarOutside);
    if (uTiles && !uTilesMosaic) {
      float u = angle * uTileAngleBands;
      float v = abs(d) / spacing;
      float parity = mod(floor(u) + floor(v), 2.0);
      // blend towards half shade right at the tile edges, they are anti-aliased like the contour bands
      float edgePx = min(wrappedLineDistancePx(u), abs(fract(v + 0.5) - 0.5) * spacing / pxD);
      color *= 1.0 - uTileContrast * mix(0.5, parity, clamp(edgePx, 0.0, 1.0));
    }
    if (uRadialLines > 0.0) {
      // next to a straight edge the direction is constant, a line there would flood the whole region, so none is drawn
      float coverage = line(wrappedLineDistancePx(angle * uRadialLines), uRadialWidth * uDevicePixelRatio);
      color = mix(color, uContourColor, uContourOpacity * coverage);
    }
  } else if (uMode == 2) {
    if (shape < 0) {
      color = uBackground;
    } else {
      vec4 c = texelFetch(uColors, ivec2(shape % uColorsWidth, shape / uColorsWidth), 0);
      color = mix(uBackground, c.rgb, c.a);
      float k = 1.0 - exp(-abs(d) / max(uShapeRange, 1e-6));
      color = inside ? color * (1.0 - uShadeInside * k) : mix(color, uBackground, uFadeOutside * k);
    }
  } else {
    color = vec3(clamp(0.5 + 0.5 * d / max(uGrayRange, 1e-6), 0.0, 1.0));
  }

  if (uContours && (inside ? uContourSides.x : uContourSides.y)) {
    float v = (d - uContourOffset) / max(uContourSpacing, 1e-6);
    // distance to the nearest contour line in device px
    float distancePx = abs(fract(v + 0.5) - 0.5) * uContourSpacing / pxD;
    float coverage = uContourBands
      ? mix(0.5, mod(floor(v), 2.0), clamp(distancePx, 0.0, 1.0)) // alternate bands, blended right at the edges
      : line(distancePx, uContourWidth * uDevicePixelRatio);
    color = mix(color, uContourColor, uContourOpacity * coverage);
  }

  if (uOutline) {
    float distancePx = abs(d) / pxD;
    color = mix(color, uOutlineColor, line(distancePx, uOutlineWidth * uDevicePixelRatio));
  }

  outColor = vec4(color, 1.0);
}

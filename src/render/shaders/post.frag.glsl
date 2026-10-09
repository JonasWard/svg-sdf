#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

// distance buffer: signed distance, vector to the nearest edge point (x, y), shape id
uniform sampler2D uSdf;
uniform ivec2 uSdfSize;
uniform vec4 uRegion; // minX, minY, maxX, maxY in world units
uniform float uPixelSize;
// rows 0 (inside) and 1 (outside), 256 samples each
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

  vec3 color;
  if (uMode == 0) {
    float range = inside ? uRampRange.x : uRampRange.y;
    float r = abs(d) / max(range, 1e-6);
    r = uRampRepeat ? fract(r) : clamp(r, 0.0, 1.0);
    color = texture(uRamp, vec2((r * 255.0 + 0.5) / 256.0, inside ? 0.25 : 0.75)).rgb;
  } else if (uMode == 1) {
    float angle = atan(gradient.y, gradient.x) / TAU;
    float hue = fract(angle * uPolarRepetitions + uHueOffset);
    float k = 1.0 - exp(-abs(d) / max(uPolarRange, 1e-6));
    vec4 side = inside ? uPolarInside : uPolarOutside;
    color = hsv2rgb(vec3(hue, mix(side.x, side.y, k), mix(side.z, side.w, k)));
    if (uRadialLines > 0.0) {
      float u = angle * uRadialLines;
      // the derivative of the wrapped coordinate, without the jump at the wrap
      float du = min(fwidth(u), fwidth(fract(u + 0.5)));
      float a = fract(u);
      float distancePx = min(a, 1.0 - a) / max(du, 1e-12);
      // next to a straight edge the direction is constant, a line there would flood the whole region
      float coverage = du > 1e-9 ? line(distancePx, uRadialWidth * uDevicePixelRatio) : 0.0;
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
    float distancePx = abs(fract(v + 0.5) - 0.5) * uContourSpacing / px;
    float coverage = uContourBands
      ? mix(0.5, mod(floor(v), 2.0), clamp(distancePx, 0.0, 1.0)) // alternate bands, blended right at the edges
      : line(distancePx, uContourWidth * uDevicePixelRatio);
    color = mix(color, uContourColor, uContourOpacity * coverage);
  }

  if (uOutline) {
    float distancePx = abs(d) / px;
    color = mix(color, uOutlineColor, line(distancePx, uOutlineWidth * uDevicePixelRatio));
  }

  outColor = vec4(color, 1.0);
}

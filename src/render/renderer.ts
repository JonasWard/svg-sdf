import { SdfBuffer } from '../lib/types';
import { parseColor } from '../lib/svg/color';
import { PostSettings, RampStop, View } from './settings';
import vertexSource from './shaders/fullscreen.vert.glsl?raw';
import fragmentSource from './shaders/post.frag.glsl?raw';

const MODE_INDEX = { ramp: 0, polar: 1, shape: 2, grayscale: 3 } as const;
const RAMP_SAMPLES = 256;
const COLORS_WIDTH = 1024;

const UNIFORMS = [
  'uSdf',
  'uSdfSize',
  'uRegion',
  'uPixelSize',
  'uRamp',
  'uColors',
  'uColorsWidth',
  'uViewport',
  'uCenter',
  'uScale',
  'uDevicePixelRatio',
  'uMode',
  'uBackground',
  'uRampRange',
  'uRampRepeat',
  'uPolarRepetitions',
  'uHueOffset',
  'uPolarRange',
  'uPolarInside',
  'uPolarOutside',
  'uRadialLines',
  'uRadialWidth',
  'uShapeRange',
  'uShadeInside',
  'uFadeOutside',
  'uGrayRange',
  'uContours',
  'uContourBands',
  'uContourSpacing',
  'uContourOffset',
  'uContourWidth',
  'uContourColor',
  'uContourOpacity',
  'uContourSides',
  'uOutline',
  'uOutlineWidth',
  'uOutlineColor'
] as const;
type UniformName = (typeof UNIFORMS)[number];

const compileShader = (gl: WebGL2RenderingContext, type: GLenum, source: string) => {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('shader compilation failed: ' + log);
  }
  return shader;
};

const createProgram = (gl: WebGL2RenderingContext) => {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error('shader link failed: ' + gl.getProgramInfoLog(program));
  return program;
};

const rgb = (color: string): [number, number, number] => {
  const c = parseColor(color) ?? [0, 0, 0, 1];
  return [c[0], c[1], c[2]];
};

/** samples the stops into RAMP_SAMPLES rgba8 pixels, interpolating in srgb */
const sampleRamp = (stops: RampStop[], out: Uint8Array, offset: number) => {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos).map((s) => ({ pos: s.pos, c: rgb(s.color) }));
  if (!sorted.length) sorted.push({ pos: 0, c: [0, 0, 0] });
  for (let i = 0; i < RAMP_SAMPLES; i++) {
    const t = i / (RAMP_SAMPLES - 1);
    let k = 0;
    while (k < sorted.length - 1 && sorted[k + 1].pos < t) k++;
    const a = sorted[k];
    const b = sorted[Math.min(k + 1, sorted.length - 1)];
    const f = t <= a.pos ? 0 : t >= b.pos ? 1 : (t - a.pos) / Math.max(b.pos - a.pos, 1e-9);
    for (let ch = 0; ch < 3; ch++) out[offset + i * 4 + ch] = Math.round((a.c[ch] + (b.c[ch] - a.c[ch]) * f) * 255);
    out[offset + i * 4 + 3] = 255;
  }
};

/**
 * Draws a distance buffer through the post-processing shader. The buffer is uploaded once, everything else is
 * uniforms or tiny textures, so changing settings or the view only costs a redraw.
 */
export class SdfRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly u: Record<UniformName, WebGLUniformLocation | null>;
  private readonly sdfTexture: WebGLTexture;
  private readonly rampTexture: WebGLTexture;
  private readonly colorTexture: WebGLTexture;
  private sdf: SdfBuffer | null = null;
  private settings: PostSettings | null = null;
  private view: View = { cx: 0, cy: 0, scale: 1 };
  private dpr = 1;
  private frame = 0;
  private rampKey = '';

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.program = createProgram(gl);
    this.vao = gl.createVertexArray()!;
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(this.program, n)])) as Record<
      UniformName,
      WebGLUniformLocation | null
    >;
    const texture = (filter: GLenum) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.sdfTexture = texture(gl.NEAREST);
    this.rampTexture = texture(gl.LINEAR);
    this.colorTexture = texture(gl.NEAREST);
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
  }

  setSdf(sdf: SdfBuffer | null) {
    this.sdf = sdf;
    const gl = this.gl;
    if (sdf) {
      gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, sdf.width, sdf.height, 0, gl.RGBA, gl.FLOAT, sdf.data);

      const n = Math.max(1, sdf.colors.length);
      const w = Math.min(n, COLORS_WIDTH);
      const h = Math.ceil(n / COLORS_WIDTH);
      const pixels = new Uint8Array(w * h * 4);
      sdf.colors.forEach((c, i) => {
        const color = c ?? [0.6, 0.6, 0.6, 1];
        for (let ch = 0; ch < 4; ch++) pixels[i * 4 + ch] = Math.round(color[ch] * 255);
      });
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    this.requestRender();
  }

  setSettings(settings: PostSettings) {
    this.settings = settings;
    const key = JSON.stringify([settings.ramp.inside, settings.ramp.outside]);
    if (key !== this.rampKey) {
      this.rampKey = key;
      const pixels = new Uint8Array(RAMP_SAMPLES * 2 * 4);
      sampleRamp(settings.ramp.inside, pixels, 0);
      sampleRamp(settings.ramp.outside, pixels, RAMP_SAMPLES * 4);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, RAMP_SAMPLES, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    this.requestRender();
  }

  setView(view: View) {
    this.view = view;
    this.requestRender();
  }

  /** sizes the drawing buffer to the canvas' css size times the device pixel ratio */
  resize(cssWidth: number, cssHeight: number, dpr: number) {
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.requestRender();
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw(this.canvas.width, this.canvas.height, this.view, this.dpr);
    });
  }

  /**
   * Renders `view` into an offscreen image of width x height device px and returns it as a png.
   * `dpr` scales line widths, so a high resolution export keeps lines as wide relative to the image.
   */
  async renderImage(width: number, height: number, view: View, dpr: number): Promise<Blob> {
    const gl = this.gl;
    const max = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), this.maxTextureSize);
    if (width > max || height > max) throw new Error(`image too large, at most ${max} px per side`);
    const target = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    const pixels = new Uint8Array(width * height * 4);
    try {
      this.draw(width, height, view, dpr);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(target);
    }
    // gl rows start at the bottom
    const image = new ImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++)
      image.data.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.putImageData(image, 0, 0);
    this.requestRender();
    return new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png encoding failed'))), 'image/png')
    );
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    const gl = this.gl;
    gl.deleteTexture(this.sdfTexture);
    gl.deleteTexture(this.rampTexture);
    gl.deleteTexture(this.colorTexture);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  private draw(width: number, height: number, view: View, dpr: number) {
    const gl = this.gl;
    const s = this.settings;
    gl.viewport(0, 0, width, height);
    const bg = rgb(s?.background ?? '#000');
    if (!this.sdf || !s) {
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const sdf = this.sdf;
    const u = this.u;
    // settings distances are percent of the larger side of the buffer region
    const unit = Math.max(sdf.region.maxX - sdf.region.minX, sdf.region.maxY - sdf.region.minY) / 100;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.uniform1i(u.uSdf, 0);
    gl.uniform1i(u.uRamp, 1);
    gl.uniform1i(u.uColors, 2);
    gl.uniform1i(u.uColorsWidth, Math.min(Math.max(1, sdf.colors.length), COLORS_WIDTH));
    gl.uniform2i(u.uSdfSize, sdf.width, sdf.height);
    gl.uniform4f(u.uRegion, sdf.region.minX, sdf.region.minY, sdf.region.maxX, sdf.region.maxY);
    gl.uniform1f(u.uPixelSize, sdf.pixelSize);

    gl.uniform2f(u.uViewport, width, height);
    gl.uniform2f(u.uCenter, view.cx, view.cy);
    gl.uniform1f(u.uScale, view.scale / dpr);
    gl.uniform1f(u.uDevicePixelRatio, dpr);

    gl.uniform1i(u.uMode, MODE_INDEX[s.mode]);
    gl.uniform3f(u.uBackground, ...bg);
    gl.uniform2f(u.uRampRange, s.ramp.rangeInside * unit, s.ramp.rangeOutside * unit);
    gl.uniform1i(u.uRampRepeat, s.ramp.repeat ? 1 : 0);

    const p = s.polar;
    gl.uniform1f(u.uPolarRepetitions, p.repetitions);
    gl.uniform1f(u.uHueOffset, p.hueOffset);
    gl.uniform1f(u.uPolarRange, p.range * unit);
    gl.uniform4f(u.uPolarInside, p.inside.satNear, p.inside.satFar, p.inside.valNear, p.inside.valFar);
    gl.uniform4f(u.uPolarOutside, p.outside.satNear, p.outside.satFar, p.outside.valNear, p.outside.valFar);
    gl.uniform1f(u.uRadialLines, p.radialLines);
    gl.uniform1f(u.uRadialWidth, p.radialWidth);

    gl.uniform1f(u.uShapeRange, s.shape.range * unit);
    gl.uniform1f(u.uShadeInside, s.shape.shadeInside);
    gl.uniform1f(u.uFadeOutside, s.shape.fadeOutside);
    gl.uniform1f(u.uGrayRange, s.grayscale.range * unit);

    const c = s.contours;
    gl.uniform1i(u.uContours, c.enabled ? 1 : 0);
    gl.uniform1i(u.uContourBands, c.style === 'bands' ? 1 : 0);
    gl.uniform1f(u.uContourSpacing, c.spacing * unit);
    gl.uniform1f(u.uContourOffset, c.offset * unit);
    gl.uniform1f(u.uContourWidth, c.width);
    gl.uniform3f(u.uContourColor, ...rgb(c.color));
    gl.uniform1f(u.uContourOpacity, c.opacity);
    gl.uniform2i(u.uContourSides, c.inside ? 1 : 0, c.outside ? 1 : 0);

    gl.uniform1i(u.uOutline, s.outline.enabled ? 1 : 0);
    gl.uniform1f(u.uOutlineWidth, s.outline.width);
    gl.uniform3f(u.uOutlineColor, ...rgb(s.outline.color));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

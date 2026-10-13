import { computeOnBackend } from '../lib/gpu/computer';
import { GpuBackend } from '../lib/gpu/kernel';
import { computeLayout, computeSdf } from '../lib/sdf/compute';
import { parseSvg } from '../lib/svg/parse';
import { flattenGeometry } from '../lib/svg/scene';
import { Bounds, CurveMode, MetricSpec, SDF_STRIDE, SdfBuffer, toMetricSpec } from '../lib/types';
import { parseColor } from '../lib/svg/color';
import { PRESETS } from '../render/presets';
import { SdfRenderer } from '../render/renderer';
import { DEFAULT_SETTINGS, PostSettings } from '../render/settings';
import { merge } from './files';
import { BenchmarkSizes, runBenchmark } from './benchmark';

interface CompareOptions {
  width: number;
  padding?: number;
  curves?: CurveMode;
  metric?: Partial<MetricSpec>;
}

/**
 * Computes one svg on the cpu (float64 reference) and on a gpu backend and summarises the differences, in buffer
 * pixels. Used by the browser tests; harmless otherwise.
 */
const compare = async (svgText: string, options: CompareOptions, backend: GpuBackend) => {
  const geometry = parseSvg(svgText);
  const sdfOptions = { width: options.width, padding: options.padding ?? 0.15, metric: toMetricSpec(options.metric) };
  const { pixelSize } = computeLayout(geometry.bounds, sdfOptions);
  const scene = flattenGeometry(geometry, 0.25 * pixelSize, options.curves ?? 'exact');
  let start = performance.now();
  const cpu = computeSdf(scene, sdfOptions);
  const cpuMs = performance.now() - start;
  start = performance.now();
  const gpu = await computeOnBackend(backend, scene, sdfOptions);
  const gpuMs = performance.now() - start;

  const n = cpu.width * cpu.height;
  let maxDistance = 0;
  let maxVector = 0;
  let signMismatches = 0;
  let shapeMismatches = 0;
  for (let k = 0; k < n; k++) {
    const o = k * SDF_STRIDE;
    const a = cpu.data[o];
    const b = gpu.data[o];
    maxDistance = Math.max(maxDistance, Math.abs(a - b) / pixelSize);
    if (Math.sign(a) !== Math.sign(b) && Math.abs(a) > 1e-6) signMismatches++;
    // the nearest point may differ where edges tie, the distance it realises may not
    const la = Math.hypot(cpu.data[o + 1], cpu.data[o + 2]);
    const lb = Math.hypot(gpu.data[o + 1], gpu.data[o + 2]);
    maxVector = Math.max(maxVector, Math.abs(la - lb) / pixelSize / Math.max(1, Math.abs(a) / pixelSize));
    if (cpu.data[o + 3] !== gpu.data[o + 3]) shapeMismatches++;
  }
  return { pixels: n, maxDistance, maxVector, signMismatches, shapeMismatches, cpuMs, gpuMs };
};

interface RenderOptions extends CompareOptions {
  /** a preset from src/render/presets.ts to start from, the default settings otherwise */
  preset?: string;
  /** deep overrides of the post settings */
  post?: unknown;
  /** fill colours given to the svg's shapes in order, cycling, so the shapes mode tells regions apart */
  regionColors?: string[];
  /** device px per css px for the image: line widths in the settings are css px */
  lineScale?: number;
  /** only compute this part of the svg, in svg units, for detail images; padding defaults to 0 then */
  region?: Bounds;
  /** how closely polylines follow curves, in buffer px */
  tolerance?: number;
  /**
   * Renders how far the distances differ from a second computation with these curve settings instead of the field
   * itself: the difference in buffer px, divided by `max` and clamped, replaces the distance (keeping its sign).
   */
  difference?: { curves?: CurveMode; tolerance?: number; max: number };
}

let renderer: SdfRenderer | null = null;
const buffers = new Map<string, SdfBuffer>();

/** the buffer of an svg, cached per svg and compute options, so styles that share a metric compute once */
const computeBuffer = (svgText: string, options: RenderOptions, curves: CurveMode, tolerance: number) => {
  const metric = toMetricSpec(options.metric);
  const sdfOptions = {
    width: options.width,
    padding: options.padding ?? (options.region ? 0 : 0.15),
    region: options.region,
    metric
  };
  const key = JSON.stringify([
    svgText.length,
    svgText.slice(0, 2000),
    sdfOptions,
    curves,
    tolerance,
    options.regionColors
  ]);
  let sdf = buffers.get(key);
  if (!sdf) {
    const geometry = parseSvg(svgText);
    if (options.regionColors?.length) {
      const colors = options.regionColors;
      geometry.shapes = geometry.shapes.map((shape, i) =>
        shape.fill ? { ...shape, fill: parseColor(colors[i % colors.length]) ?? shape.fill } : shape
      );
    }
    const { pixelSize } = computeLayout(geometry.bounds, sdfOptions);
    sdf = computeSdf(flattenGeometry(geometry, tolerance * pixelSize, curves), sdfOptions);
    buffers.set(key, sdf);
  }
  return sdf;
};

/** the second buffer's distances subtracted from the first, in buffer px over `max`, clamped to 1 */
const differenceBuffer = (a: SdfBuffer, b: SdfBuffer, max: number): SdfBuffer => {
  const data = new Float32Array(a.data);
  // distances in the post settings are percent of the larger side of the region, map `max` to 100
  const side = Math.max(a.region.maxX - a.region.minX, a.region.maxY - a.region.minY);
  for (let o = 0; o < data.length; o += SDF_STRIDE) {
    const px = Math.abs(a.data[o] - b.data[o]) / a.pixelSize;
    data[o] = (a.data[o] < 0 ? -1 : 1) * Math.min(1, px / max) * side;
  }
  return { ...a, data };
};

/**
 * Renders the whole buffer of an svg to a png, one image pixel per buffer pixel, and returns it as a data url.
 */
const render = async (svgText: string, options: RenderOptions) => {
  const curves = options.curves ?? 'exact';
  const tolerance = options.tolerance ?? 0.25;
  let sdf = computeBuffer(svgText, options, curves, tolerance);
  if (options.difference) {
    const { difference } = options;
    const other = computeBuffer(svgText, options, difference.curves ?? 'polyline', difference.tolerance ?? tolerance);
    sdf = differenceBuffer(other, sdf, difference.max);
  }
  const base = options.preset ? PRESETS[options.preset] : DEFAULT_SETTINGS;
  if (!base) throw new Error(`unknown preset ${options.preset}`);
  const post = merge<PostSettings>(base, options.post);

  renderer ??= new SdfRenderer(document.createElement('canvas'));
  renderer.setSdf(sdf);
  renderer.setSettings(post);
  const lineScale = options.lineScale ?? 1;
  const { region } = sdf;
  const view = {
    cx: (region.minX + region.maxX) / 2,
    cy: (region.minY + region.maxY) / 2,
    scale: sdf.pixelSize * lineScale
  };
  const blob = await renderer.renderImage(sdf.width, sdf.height, view, lineScale);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
};

export const installDebug = () => {
  (globalThis as unknown as { svgSdfDebug: unknown }).svgSdfDebug = {
    compare,
    render,
    bounds: (svgText: string) => parseSvg(svgText).bounds,
    benchmark: (svgText: string, sizes?: Partial<BenchmarkSizes>) => runBenchmark(svgText, 'debug', () => {}, sizes)
  };
};

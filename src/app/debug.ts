import { computeOnBackend } from '../lib/gpu/computer';
import { GpuBackend } from '../lib/gpu/kernel';
import { computeLayout, computeSdf } from '../lib/sdf/compute';
import { parseSvg } from '../lib/svg/parse';
import { flattenGeometry } from '../lib/svg/scene';
import { CurveMode, MetricSpec, SDF_STRIDE, toMetricSpec } from '../lib/types';

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

export const installDebug = () => {
  (globalThis as unknown as { svgSdfDebug: unknown }).svgSdfDebug = { compare };
};

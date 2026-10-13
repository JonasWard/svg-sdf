import { Backend, computeOnBackend } from '../lib/gpu/computer';
import { computeLayout } from '../lib/sdf/compute';
import { packEdges } from '../lib/sdf/edges';
import { SdfWorkerPool } from '../lib/sdf/workerPool';
import { parseSvg } from '../lib/svg/parse';
import { flattenGeometry } from '../lib/svg/scene';
import { MetricSpec, toMetricSpec } from '../lib/types';

const BACKENDS: Backend[] = ['webgpu', 'webgl', 'cpu'];
const METRICS: Record<string, Partial<MetricSpec>> = {
  euclidean: { kind: 'euclidean' },
  manhattan: { kind: 'manhattan' },
  chebyshev: { kind: 'chebyshev' },
  l4: { kind: 'lp', p: 4 },
  triangle: { kind: 'polygon', sides: 3 }
};
const PADDING = 0.1;

export interface BenchmarkSizes {
  /** every metric at this width, the euclidean one also at `widths` */
  metricWidth: number;
  widths: number[];
  /** timed runs per case, after one untimed warm-up run */
  runs: number;
  /** time software gpus too, these take minutes for the larger buffers */
  allowSoftware: boolean;
}

const DEFAULT_SIZES: BenchmarkSizes = { metricWidth: 2048, widths: [512, 1024, 2048, 4096], runs: 3, allowSoftware: false };

export interface BenchmarkResult {
  backend: Backend;
  metric: string;
  width: number;
  height: number;
  /** wall time of each timed run, after one untimed warm-up run */
  ms: number[];
  /** null when the case did not run */
  median: number | null;
  error?: string;
}

export interface BenchmarkReport {
  version: 1;
  date: string;
  userAgent: string;
  hardwareConcurrency: number;
  svg: { name: string; lines: number; curves: number };
  /** the gpu each gpu backend ran on, and whether it is a software renderer */
  devices: Partial<Record<Backend, { name: string; software: boolean }>>;
  results: BenchmarkResult[];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Times the same svg on every backend, for a few metrics and buffer widths, with exact curves. Backends that cannot
 * run here, or only on a software renderer, are reported with an error and skipped from then on.
 */
export const runBenchmark = async (
  svgText: string,
  svgName: string,
  onProgress: (label: string, fraction: number) => void,
  sizes: Partial<BenchmarkSizes> = {}
): Promise<BenchmarkReport> => {
  const { metricWidth, widths, runs, allowSoftware } = { ...DEFAULT_SIZES, ...sizes };
  const geometry = parseSvg(svgText);
  const cases = [
    ...Object.keys(METRICS).map((metric) => ({ metric, width: metricWidth })),
    ...widths.filter((w) => w !== metricWidth).map((width) => ({ metric: 'euclidean', width }))
  ];
  const pool = new SdfWorkerPool();
  const failed = new Map<Backend, string>();
  const report: BenchmarkReport = {
    version: 1,
    date: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    svg: { name: svgName, lines: 0, curves: 0 },
    devices: {},
    results: []
  };

  const total = BACKENDS.length * cases.length;
  let step = 0;
  for (const backend of BACKENDS) {
    for (const { metric, width } of cases) {
      onProgress(`${backend} · ${metric} · ${width} px`, step++ / total);
      const options = { width, padding: PADDING, metric: toMetricSpec(METRICS[metric]) };
      const { pixelSize, height } = computeLayout(geometry.bounds, options);
      const scene = flattenGeometry(geometry, 0.25 * pixelSize, 'exact');
      if (!report.svg.lines) {
        const { lines, curves } = packEdges(scene);
        report.svg = { name: svgName, lines, curves };
      }
      const result: BenchmarkResult = { backend, metric, width, height, ms: [], median: null };
      report.results.push(result);
      if (failed.has(backend)) {
        result.error = failed.get(backend);
        continue;
      }
      try {
        for (let run = 0; run <= runs; run++) {
          const start = performance.now();
          if (backend === 'cpu') await pool.compute(scene, options).promise;
          else {
            const sdf = await computeOnBackend(backend, scene, options);
            report.devices[backend] ??= { name: sdf.device ?? backend, software: sdf.software ?? false };
            if (sdf.software && !allowSoftware) throw new Error(`software renderer (${sdf.device}), not timed`);
          }
          if (run > 0) result.ms.push(performance.now() - start);
        }
        result.median = median(result.ms);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        result.error = message;
        // a buffer too large for this gpu only fails this case, anything else the whole backend
        if (!/too large|limit|exceed/i.test(message)) failed.set(backend, message);
      }
    }
  }
  pool.dispose();
  onProgress('done', 1);
  return report;
};

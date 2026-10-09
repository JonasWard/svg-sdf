import { computeLayout, sceneColors, SdfOptions } from '../sdf/compute';
import { CancelledError, SdfWorkerPool } from '../sdf/workerPool';
import { Scene, SdfBuffer, toMetricSpec } from '../types';
import type { GpuRequest, GpuResponse } from './gpu.worker';
import { GpuBackend } from './kernel';

export type BackendPreference = 'auto' | 'webgpu' | 'webgl' | 'cpu';
export type Backend = 'webgpu' | 'webgl' | 'cpu';

export interface ComputeResult {
  sdf: SdfBuffer;
  /** the backend that produced the buffer */
  backend: Backend;
  /** why preferred backends were skipped */
  notes: string[];
}

export interface ComputeJob {
  promise: Promise<ComputeResult>;
  cancel: () => void;
}

class BackendError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'software' | 'failed'
  ) {
    super(message);
  }
}

/** runs gpu jobs in one worker, which keeps its kernels (compiled shaders) between jobs */
class GpuRunner {
  private worker: Worker | null = null;
  private job = 0;

  run(
    backend: GpuBackend,
    scene: Scene,
    options: SdfOptions,
    allowSoftware: boolean,
    onProgress?: (f: number) => void
  ) {
    const job = ++this.job;
    const layout = computeLayout(scene.bounds, options);
    const metric = toMetricSpec(options.metric);
    this.worker ??= new Worker(new URL('./gpu.worker.ts', import.meta.url), { type: 'module' });
    const worker = this.worker;
    let reject = (_: Error) => {};
    const promise = new Promise<SdfBuffer>((resolve, rej) => {
      reject = rej;
      worker.onmessage = (event: MessageEvent<GpuResponse>) => {
        const msg = event.data;
        if (msg.job !== job) return;
        if (msg.type === 'progress') onProgress?.(msg.fraction);
        else if (msg.type === 'error') rej(new BackendError(msg.message, msg.reason));
        else resolve({ ...layout, data: msg.data, metric, colors: sceneColors(scene), backend });
      };
      worker.onerror = (event) => rej(new BackendError(event.message || 'gpu worker failed', 'unsupported'));
      worker.postMessage({ type: 'compute', job, backend, scene, layout, metric, allowSoftware } satisfies GpuRequest);
    });
    const cancel = () => {
      worker.postMessage({ type: 'cancel', job } satisfies GpuRequest);
      reject(new CancelledError());
    };
    return { promise, cancel };
  }
}

let debugRunner: GpuRunner | null = null;

/** one gpu backend without fallback, for comparisons against the cpu reference */
export const computeOnBackend = (backend: GpuBackend, scene: Scene, options: SdfOptions) => {
  debugRunner ??= new GpuRunner();
  return debugRunner.run(backend, scene, options, true).promise;
};

/**
 * Computes distance buffers on the preferred backend, falling back from webgpu to webgl to the cpu workers.
 * Backends that cannot run in this browser at all are remembered and skipped from then on.
 */
export class SdfComputer {
  private readonly cpu = new SdfWorkerPool();
  private readonly gpu = new GpuRunner();
  /** backends that cannot run in this browser */
  private readonly unsupported = new Map<GpuBackend, string>();
  /** backends on a software renderer, which auto skips */
  private readonly software = new Map<GpuBackend, string>();
  private cancelCurrent: () => void = () => {};

  compute(
    scene: Scene,
    options: SdfOptions,
    preference: BackendPreference,
    onProgress?: (f: number) => void
  ): ComputeJob {
    this.cancelCurrent();
    let cancelled = false;
    let cancelStep = () => {};
    const cancel = () => {
      cancelled = true;
      cancelStep();
    };
    this.cancelCurrent = cancel;
    const order: Backend[] =
      preference === 'auto' ? ['webgpu', 'webgl', 'cpu'] : preference === 'cpu' ? ['cpu'] : [preference, 'cpu'];

    const promise = (async (): Promise<ComputeResult> => {
      const notes: string[] = [];
      for (const backend of order) {
        if (cancelled) throw new CancelledError();
        if (backend === 'cpu') {
          const job = this.cpu.compute(scene, options, onProgress);
          cancelStep = job.cancel;
          const sdf = await job.promise;
          return { sdf: { ...sdf, backend: 'cpu' }, backend, notes };
        }
        // auto skips software renderers, an explicit choice runs on them
        const allowSoftware = preference !== 'auto';
        const reason = this.unsupported.get(backend) ?? (allowSoftware ? undefined : this.software.get(backend));
        if (reason) {
          notes.push(`${backend}: ${reason}`);
          continue;
        }
        try {
          const job = this.gpu.run(backend, scene, options, allowSoftware, onProgress);
          cancelStep = job.cancel;
          return { sdf: await job.promise, backend, notes };
        } catch (e) {
          if (e instanceof CancelledError || cancelled) throw new CancelledError();
          const message = e instanceof Error ? e.message : String(e);
          if (e instanceof BackendError && e.reason === 'unsupported') this.unsupported.set(backend, message);
          if (e instanceof BackendError && e.reason === 'software') this.software.set(backend, message);
          notes.push(`${backend}: ${message}`);
        }
      }
      throw new Error(notes.join('; ') || 'no backend could compute the buffer');
    })();
    return { promise, cancel };
  }
}

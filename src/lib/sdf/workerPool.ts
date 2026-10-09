import { Scene, SDF_STRIDE, SdfBuffer } from '../types';
import { computeLayout, sceneColors, SdfOptions } from './compute';
import { WorkerRequest, WorkerResponse } from './protocol';

export interface SdfJob {
  promise: Promise<SdfBuffer>;
  cancel: () => void;
}

const CHUNK_PIXELS = 64 * 1024; // pixels per task, small enough for steady progress and load balancing

/**
 * Computes distance fields on a pool of web workers, splitting the buffer into row bands.
 * Starting a new job cancels the running one.
 */
export class SdfWorkerPool {
  private workers: Worker[] = [];
  private jobId = 0;
  private current: { reject: (e: Error) => void } | null = null;

  constructor(private readonly size = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8))) {}

  compute(scene: Scene, options: SdfOptions, onProgress?: (fraction: number) => void): SdfJob {
    this.cancelCurrent();
    const job = ++this.jobId;
    const layout = computeLayout(scene.bounds, options);
    const { width, height } = layout;
    const data = new Float32Array(width * height * SDF_STRIDE);
    const rowsPerTask = Math.max(1, Math.floor(CHUNK_PIXELS / width));
    const tasks: [number, number][] = [];
    for (let r = 0; r < height; r += rowsPerTask) tasks.push([r, Math.min(height, r + rowsPerTask)]);

    let cancel = () => undefined as void;
    const promise = new Promise<SdfBuffer>((resolve, reject) => {
      this.current = { reject };
      cancel = () => {
        if (this.jobId !== job) return;
        this.cancelCurrent();
      };
      this.ensureWorkers();
      let nextTask = 0;
      let doneRows = 0;

      const feed = (worker: Worker) => {
        if (nextTask >= tasks.length) return;
        const [rowStart, rowEnd] = tasks[nextTask++];
        worker.postMessage({ type: 'rows', job, rowStart, rowEnd } satisfies WorkerRequest);
      };

      for (const worker of this.workers) {
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          const msg = event.data;
          if (msg.job !== job) return;
          if (msg.type === 'error') {
            this.cancelCurrent(new Error(msg.message));
            return;
          }
          data.set(msg.data, msg.rowStart * width * SDF_STRIDE);
          doneRows += msg.rowEnd - msg.rowStart;
          onProgress?.(doneRows / height);
          if (doneRows === height) {
            this.current = null;
            resolve({ ...layout, data, colors: sceneColors(scene) });
          } else feed(worker);
        };
        worker.onerror = (event) => this.cancelCurrent(new Error(event.message || 'worker failed'));
        worker.postMessage({ type: 'scene', job, scene, layout } satisfies WorkerRequest);
        // two tasks in flight per worker so it never idles waiting for the next one
        feed(worker);
        feed(worker);
      }
    });
    return { promise, cancel };
  }

  dispose() {
    this.cancelCurrent();
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  private ensureWorkers() {
    while (this.workers.length < this.size)
      this.workers.push(new Worker(new URL('./sdf.worker.ts', import.meta.url), { type: 'module' }));
  }

  /** rejects the running job; its workers are terminated so they stop computing stale rows right away */
  private cancelCurrent(error: Error = new CancelledError()) {
    if (!this.current) return;
    const { reject } = this.current;
    this.current = null;
    this.jobId++;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    reject(error);
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

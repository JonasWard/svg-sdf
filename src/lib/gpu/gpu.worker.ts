/// <reference lib="webworker" />
import { MetricSpec, Scene, SdfLayout } from '../types';
import { prepareScene } from '../sdf/compute';
import { GpuBackend, GpuKernel } from './kernel';
import { computeOnGpu } from './run';
import { WebGlKernel } from './webgl';
import { WebGpuKernel } from './webgpu';

export type GpuRequest =
  | {
      type: 'compute';
      job: number;
      backend: GpuBackend;
      scene: Scene;
      layout: SdfLayout;
      metric: MetricSpec;
      /** run on a software renderer too; auto selection does not, those are slower than the cpu */
      allowSoftware: boolean;
    }
  | { type: 'cancel'; job: number };

export type GpuResponse =
  | { type: 'progress'; job: number; fraction: number }
  | { type: 'result'; job: number; data: Float32Array }
  /** unsupported: the backend cannot run here at all; software: it runs, but on a software renderer; failed: on this scene */
  | { type: 'error'; job: number; message: string; reason: 'unsupported' | 'software' | 'failed' };

const post = (message: GpuResponse, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);

// kernels stay alive between jobs, so shaders compile once
const kernels = new Map<GpuBackend, Promise<GpuKernel>>();
const cancelled = new Set<number>();
let latestJob = -1;
// jobs run one after another: a kernel holds one scene and its readback buffers at a time
let queue: Promise<void> = Promise.resolve();

const kernelFor = (backend: GpuBackend) => {
  let kernel = kernels.get(backend);
  if (!kernel) {
    kernel = backend === 'webgpu' ? WebGpuKernel.create() : Promise.resolve().then(() => new WebGlKernel());
    kernels.set(backend, kernel);
  }
  return kernel;
};

const run = async (msg: Extract<GpuRequest, { type: 'compute' }>) => {
  const { job } = msg;
  // a newer job supersedes this one, so does a cancel
  const stop = () => cancelled.has(job) || latestJob !== job;
  if (stop()) return;
  let kernel: GpuKernel;
  try {
    kernel = await kernelFor(msg.backend);
  } catch (e) {
    kernels.delete(msg.backend);
    post({ type: 'error', job, message: e instanceof Error ? e.message : String(e), reason: 'unsupported' });
    return;
  }
  if (kernel.software && !msg.allowSoftware) {
    post({
      type: 'error',
      job,
      message: `software renderer (${kernel.description}), slower than the cpu`,
      reason: 'software'
    });
    return;
  }
  try {
    const prepared = prepareScene(msg.scene, msg.metric);
    const data = await computeOnGpu(
      kernel,
      prepared,
      msg.layout,
      (fraction) => post({ type: 'progress', job, fraction }),
      stop
    );
    post({ type: 'result', job, data }, [data.buffer]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // a lost device or context is gone for good, start fresh next time
    if (/lost/i.test(message)) {
      kernels.delete(msg.backend);
      kernel.dispose();
    }
    post({ type: 'error', job, message, reason: 'failed' });
  } finally {
    cancelled.delete(job);
  }
};

self.onmessage = (event: MessageEvent<GpuRequest>) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.job);
    return;
  }
  latestJob = msg.job;
  queue = queue.then(() => run(msg));
};

import { MetricSpec, Scene, SdfLayout } from '../types';

export type WorkerRequest =
  | { type: 'scene'; job: number; scene: Scene; layout: SdfLayout; metric: MetricSpec }
  | { type: 'rows'; job: number; rowStart: number; rowEnd: number };

export type WorkerResponse =
  | { type: 'rows'; job: number; rowStart: number; rowEnd: number; data: Float32Array }
  | { type: 'error'; job: number; message: string };

/// <reference lib="webworker" />
import { SdfLayout } from '../types';
import { computeRows, prepareScene, PreparedScene } from './compute';
import { WorkerRequest, WorkerResponse } from './protocol';

let job = -1;
let prepared: PreparedScene | null = null;
let layout: SdfLayout | null = null;

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'scene') {
      job = msg.job;
      layout = msg.layout;
      prepared = prepareScene(msg.scene);
      return;
    }
    if (msg.job !== job || !prepared || !layout) return;
    const data = computeRows(prepared, layout, msg.rowStart, msg.rowEnd);
    post({ type: 'rows', job, rowStart: msg.rowStart, rowEnd: msg.rowEnd, data }, [data.buffer]);
  } catch (e) {
    post({ type: 'error', job: msg.job, message: e instanceof Error ? e.message : String(e) });
  }
};

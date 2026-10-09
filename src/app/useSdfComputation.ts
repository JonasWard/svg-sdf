import { useEffect } from 'react';
import { parseSvg } from '../lib/svg/parse';
import { flattenGeometry } from '../lib/svg/scene';
import { computeLayout } from '../lib/sdf/compute';
import { CancelledError, SdfWorkerPool } from '../lib/sdf/workerPool';
import { useStore } from './store';

const DEBOUNCE_MS = 200;
let pool: SdfWorkerPool | null = null;

/** recomputes the distance buffer whenever the svg or the buffer settings change */
export const useSdfComputation = () => {
  const svgText = useStore((s) => s.svgText);
  const compute = useStore((s) => s.compute);

  useEffect(() => {
    const { setStatus, setSdf } = useStore.getState();
    let cancel = () => {};
    let stale = false;
    const timer = setTimeout(async () => {
      const start = performance.now();
      try {
        setStatus({ state: 'computing', progress: 0 });
        const geometry = parseSvg(svgText);
        const options = { width: compute.width, padding: compute.padding / 100 };
        // flatten curves to a fraction of a buffer pixel
        const { pixelSize } = computeLayout(geometry.bounds, options);
        const scene = flattenGeometry(geometry, compute.tolerance * pixelSize);
        const segments = scene.shapes.reduce(
          (n, s) => n + s.contours.reduce((m, c) => m + c.points.length / 2 - (c.closed ? 0 : 1), 0),
          0
        );
        pool ??= new SdfWorkerPool();
        const job = pool.compute(scene, options, (progress) => {
          if (!stale) setStatus({ state: 'computing', progress, segments });
        });
        cancel = job.cancel;
        const sdf = await job.promise;
        if (stale) return;
        setSdf(sdf);
        setStatus({ state: 'done', progress: 1, ms: performance.now() - start, segments });
      } catch (e) {
        if (stale || e instanceof CancelledError) return;
        setStatus({ state: 'error', progress: 0, message: e instanceof Error ? e.message : String(e) });
      }
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
      cancel();
    };
  }, [svgText, compute]);
};

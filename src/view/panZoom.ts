import { View } from '../render/settings';

const MIN_SCALE = 1e-6;
const MAX_SCALE = 1e6;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** zooms by `factor` (> 1 zooms out) keeping the world point under (x, y) css px from the element centre fixed */
export const zoomAt = (view: View, factor: number, x: number, y: number): View => {
  const scale = clampScale(view.scale * factor);
  const k = view.scale - scale;
  return { cx: view.cx + x * k, cy: view.cy + y * k, scale };
};

/**
 * The view that shows `region` whole inside a width x height css px viewport, with a small margin.
 * `visible` limits it to the part of the viewport not covered by other ui, in css px from the top left.
 */
export const fitView = (
  region: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
  margin = 1.05,
  visible = { left: 0, top: 0, right: width, bottom: height }
): View => {
  const w = Math.max(visible.right - visible.left, 1);
  const h = Math.max(visible.bottom - visible.top, 1);
  const scale = clampScale(Math.max((region.maxX - region.minX) / w, (region.maxY - region.minY) / h) * margin);
  // shift so the region centre lands on the centre of the visible part
  const offsetX = (visible.left + visible.right) / 2 - width / 2;
  const offsetY = (visible.top + visible.bottom) / 2 - height / 2;
  return {
    cx: (region.minX + region.maxX) / 2 - offsetX * scale,
    cy: (region.minY + region.maxY) / 2 - offsetY * scale,
    scale
  };
};

/**
 * Mouse, touch and pen navigation: drag to pan, wheel or pinch to zoom around the cursor, double click to fit.
 * Returns a function that removes the listeners.
 */
export const attachPanZoom = (
  element: HTMLElement,
  getView: () => View,
  setView: (view: View) => void,
  onFit: () => void
): (() => void) => {
  const pointers = new Map<number, { x: number; y: number }>();

  /** pointer position relative to the element centre, css px */
  const local = (e: { clientX: number; clientY: number }) => {
    const r = element.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  /** centroid and spread of the active pointers */
  const gesture = () => {
    const pts = [...pointers.values()];
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const spread = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { x, y, spread };
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    element.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    element.style.cursor = 'grabbing';
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const before = gesture();
    pointers.set(e.pointerId, local(e));
    const after = gesture();
    let view = getView();
    // pan with the centroid, then zoom around it by how much the fingers spread
    view = {
      ...view,
      cx: view.cx - (after.x - before.x) * view.scale,
      cy: view.cy - (after.y - before.y) * view.scale
    };
    if (pointers.size > 1 && before.spread > 0 && after.spread > 0)
      view = zoomAt(view, before.spread / after.spread, after.x, after.y);
    setView(view);
  };

  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) element.style.cursor = 'grab';
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // trackpad pinches arrive as ctrl + wheel with small deltas, give them more weight
    const speed = e.ctrlKey ? 0.01 : 0.0015;
    const { x, y } = local(e);
    setView(zoomAt(getView(), Math.exp(e.deltaY * lines * speed), x, y));
  };

  const onDoubleClick = () => onFit();

  element.style.cursor = 'grab';
  element.style.touchAction = 'none';
  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('dblclick', onDoubleClick);
  return () => {
    element.removeEventListener('pointerdown', onPointerDown);
    element.removeEventListener('pointermove', onPointerMove);
    element.removeEventListener('pointerup', onPointerUp);
    element.removeEventListener('pointercancel', onPointerUp);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('dblclick', onDoubleClick);
  };
};

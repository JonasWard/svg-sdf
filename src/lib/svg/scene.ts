import { CurveMode, Scene, SvgGeometry } from '../types';
import { flattenSubpaths } from './pathData';

/**
 * Prepares a parsed svg for the distance computation.
 * - `polyline`: curves are flattened into polylines within `tolerance` svg units of the true outline
 * - `exact`: the bezier curves are kept and distances are measured to them directly, `tolerance` is unused
 * Filled shapes get all their subpaths closed, as svg fills open subpaths as if they were closed;
 * unfilled shapes keep their open subpaths open and only contribute edges.
 */
export const flattenGeometry = (geometry: SvgGeometry, tolerance: number, mode: CurveMode = 'polyline'): Scene => ({
  bounds: geometry.bounds,
  shapes: geometry.shapes
    .map((shape) => {
      const filled = shape.fill !== null;
      if (mode === 'exact') {
        const curves = shape.subpaths
          .filter((sp) => sp.segments.length)
          .map((sp) => ({ ...sp, closed: sp.closed || filled }));
        return { fill: shape.fill, stroke: shape.stroke, fillRule: shape.fillRule, contours: [], curves };
      }
      return {
        fill: shape.fill,
        stroke: shape.stroke,
        fillRule: shape.fillRule,
        contours: flattenSubpaths(shape.subpaths, tolerance, filled)
      };
    })
    .filter((shape) => shape.contours.length || shape.curves?.length)
});

import { Scene, SvgGeometry } from '../types';
import { flattenSubpaths } from './pathData';

/**
 * Flattens the curves of a parsed svg into polylines within `tolerance` svg units of the true outline.
 * Filled shapes get all their contours closed, as svg fills open subpaths as if they were closed;
 * unfilled shapes keep their open subpaths open and only contribute edges.
 */
export const flattenGeometry = (geometry: SvgGeometry, tolerance: number): Scene => ({
  bounds: geometry.bounds,
  shapes: geometry.shapes
    .map((shape) => ({
      fill: shape.fill,
      stroke: shape.stroke,
      fillRule: shape.fillRule,
      contours: flattenSubpaths(shape.subpaths, tolerance, shape.fill !== null)
    }))
    .filter((shape) => shape.contours.length)
});

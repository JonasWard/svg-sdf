export type Mode = 'ramp' | 'polar' | 'shape' | 'grayscale';
export const MODES: Mode[] = ['polar', 'ramp', 'shape', 'grayscale'];

export interface RampStop {
  /** 0..1 along the ramp */
  pos: number;
  color: string;
}

/** where polar hues come from: an hsv rainbow, a perceptually even oklch wheel, or a cyclic gradient of own stops */
export type PolarPalette = 'hsv' | 'oklch' | 'gradient';
export const POLAR_PALETTES: PolarPalette[] = ['hsv', 'oklch', 'gradient'];

/** near/far values per side; saturation and value for hsv and gradient, chroma and lightness for oklch */
export interface PolarSide {
  satNear: number;
  satFar: number;
  valNear: number;
  valFar: number;
}

/**
 * How the distance buffer is turned into colour. All distances are in percent of the larger side of the buffer
 * region, so the same settings look alike on any svg; line widths are in css px.
 */
export interface PostSettings {
  mode: Mode;
  background: string;
  ramp: {
    inside: RampStop[];
    outside: RampStop[];
    rangeInside: number;
    rangeOutside: number;
    /** restart the ramp every range instead of clamping */
    repeat: boolean;
  };
  polar: {
    palette: PolarPalette;
    /** the cyclic gradient, positions in 0..1, wrapping from the last stop back to the first */
    stops: RampStop[];
    /** hue turns per full turn of the direction to the nearest edge */
    repetitions: number;
    /** 0..1 */
    hueOffset: number;
    /** distance over which saturation and value go from near to far */
    range: number;
    inside: PolarSide;
    outside: PolarSide;
    /** lines of constant direction, 0 for none */
    radialLines: number;
    radialWidth: number;
    /** the (direction × distance) plane cut into tiles */
    tiles: {
      enabled: boolean;
      /** checker darkens every other tile, mosaic gives every tile the flat colour of its centre */
      style: 'checker' | 'mosaic';
      /** tiles around the full turn */
      angleBands: number;
      /** tile depth along the distance */
      distanceSpacing: number;
      /** how much checker tiles darken */
      contrast: number;
    };
  };
  shape: {
    range: number;
    /** how much the shape colour darkens towards the inside */
    shadeInside: number;
    /** how much the colour of the nearest shape fades into the background outside */
    fadeOutside: number;
  };
  grayscale: {
    /** distance mapped to black (inside) and white (outside), the edge is mid grey */
    range: number;
  };
  contours: {
    enabled: boolean;
    style: 'lines' | 'bands';
    spacing: number;
    offset: number;
    width: number;
    color: string;
    opacity: number;
    inside: boolean;
    outside: boolean;
  };
  outline: {
    enabled: boolean;
    width: number;
    color: string;
  };
}

/** world position at the canvas centre and world units per css px */
export interface View {
  cx: number;
  cy: number;
  scale: number;
}

export const DEFAULT_SETTINGS: PostSettings = {
  mode: 'polar',
  background: '#f4f1ea',
  ramp: {
    inside: [
      { pos: 0, color: '#2b3a55' },
      { pos: 0.5, color: '#6f9bd1' },
      { pos: 1, color: '#e8f4ff' }
    ],
    outside: [
      { pos: 0, color: '#1c1610' },
      { pos: 0.25, color: '#b07a3b' },
      { pos: 1, color: '#e2b67a' }
    ],
    rangeInside: 15,
    rangeOutside: 25,
    repeat: false
  },
  polar: {
    palette: 'hsv',
    stops: [
      { pos: 0, color: '#e2d9e2' },
      { pos: 0.25, color: '#6f86c0' },
      { pos: 0.5, color: '#2f1436' },
      { pos: 0.75, color: '#b0573f' }
    ],
    repetitions: 1,
    hueOffset: 0,
    range: 30,
    inside: { satNear: 0.65, satFar: 0.4, valNear: 0.35, valFar: 0.45 },
    outside: { satNear: 0.85, satFar: 0.1, valNear: 0.85, valFar: 1 },
    radialLines: 0,
    radialWidth: 1,
    tiles: { enabled: false, style: 'checker', angleBands: 24, distanceSpacing: 3, contrast: 0.3 }
  },
  shape: { range: 20, shadeInside: 0.5, fadeOutside: 0.85 },
  grayscale: { range: 10 },
  contours: {
    enabled: true,
    style: 'lines',
    spacing: 1.5,
    offset: 0,
    width: 1.2,
    color: '#ffffff',
    opacity: 1,
    inside: true,
    outside: true
  },
  outline: { enabled: false, width: 3, color: '#ffffff' }
};

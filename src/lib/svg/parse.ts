import { Bounds, GeometryShape, Matrix, RGBA, Subpath, SvgGeometry } from '../types';
import { parseColor } from './color';
import { parseNumberList } from './numbers';
import { parsePathData, transformSubpaths } from './pathData';
import { IDENTITY, multiply, parseTransform, translate } from './transform';

type Style = Record<string, string>;

const INHERITED = ['fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-opacity', 'color', 'visibility'];
const PRESENTATION = [...INHERITED, 'opacity', 'display'];
const CONTAINERS = new Set(['svg', 'g', 'a', 'switch']);
const MAX_USE_DEPTH = 8;

interface CssRule {
  selector: string;
  specificity: number;
  order: number;
  declarations: Style;
}

/**
 * Parses an svg document into its filled and stroked geometry, in paint order with every transform applied.
 * Supports path, rect, circle, ellipse, line, polyline, polygon, groups and `use`, presentation attributes,
 * inline styles and simple class / id / tag rules from `<style>` blocks. Text, clipping and masking are ignored.
 */
export const parseSvg = (svgText: string): SvgGeometry => {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) throw new Error('invalid svg: ' + (error.textContent ?? '').trim().split('\n')[0]);
  const root = doc.documentElement;
  if (root.localName !== 'svg') throw new Error('the document root is not an <svg> element');

  const rules = collectCssRules(doc);
  const byId = new Map<string, Element>();
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    const id = el.getAttribute('id');
    if (id && !byId.has(id)) byId.set(id, el);
  }

  const shapes: GeometryShape[] = [];

  const resolveStyle = (el: Element, parent: Style): Style => {
    const own: Style = {};
    for (const name of PRESENTATION) {
      const v = el.getAttribute(name);
      if (v !== null) own[name] = v.trim();
    }
    for (const rule of rules) if (matches(el, rule.selector)) Object.assign(own, rule.declarations);
    Object.assign(own, parseDeclarations(el.getAttribute('style') ?? ''));

    const style: Style = {};
    for (const name of INHERITED) {
      const v = own[name];
      style[name] = v === undefined || v === 'inherit' ? parent[name] : v;
    }
    style.opacity = String(Number(parent.opacity ?? 1) * numberOr(own.opacity, 1));
    style.display = own.display ?? 'inline';
    return style;
  };

  const paint = (value: string | undefined, style: Style, opacityName: string): RGBA | null => {
    if (!value) return null;
    let color: RGBA | null;
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value);
    if (url) color = gradientColor(byId.get(url[1]));
    else if (value === 'currentColor') color = parseColor(style.color ?? 'black');
    else color = parseColor(value);
    if (!color) return null;
    return [color[0], color[1], color[2], color[3] * numberOr(style[opacityName], 1) * Number(style.opacity)];
  };

  const addShape = (subpaths: Subpath[], m: Matrix, style: Style, fillable: boolean) => {
    if (!subpaths.length || style.visibility === 'hidden' || style.visibility === 'collapse') return;
    const fill = fillable ? paint(style.fill, style, 'fill-opacity') : null;
    const stroke = paint(style.stroke, style, 'stroke-opacity');
    shapes.push({
      fill,
      stroke,
      fillRule: style['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero',
      subpaths: transformSubpaths(subpaths, m)
    });
  };

  const walk = (el: Element, parentMatrix: Matrix, parentStyle: Style, useDepth: number) => {
    const style = resolveStyle(el, parentStyle);
    if (style.display === 'none') return;
    const name = el.localName;
    let m = multiply(parentMatrix, parseTransform(el.getAttribute('transform')));

    if (CONTAINERS.has(name)) {
      if (name === 'svg' && el !== root) m = multiply(m, translate(len(el, 'x'), len(el, 'y')));
      for (const child of Array.from(el.children)) walk(child, m, style, useDepth);
      return;
    }
    if (name === 'use') {
      const href = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      const target = href?.startsWith('#') ? byId.get(href.slice(1)) : undefined;
      if (!target || useDepth >= MAX_USE_DEPTH) return;
      m = multiply(m, translate(len(el, 'x'), len(el, 'y')));
      if (target.localName === 'symbol')
        for (const child of Array.from(target.children)) walk(child, m, style, useDepth + 1);
      else walk(target, m, style, useDepth + 1);
      return;
    }
    const geometry = elementPath(el);
    if (geometry) addShape(parsePathData(geometry.d), m, style, geometry.fillable);
  };

  const rootStyle: Style = {
    fill: 'black',
    'fill-rule': 'nonzero',
    stroke: 'none',
    color: 'black',
    opacity: '1',
    visibility: 'visible'
  };
  walk(root, IDENTITY, rootStyle, 0);

  return { bounds: rootBounds(root) ?? geometryBounds(shapes), shapes };
};

/** the path data equivalent of a basic shape element */
const elementPath = (el: Element): { d: string; fillable: boolean } | null => {
  switch (el.localName) {
    case 'path':
      return { d: el.getAttribute('d') ?? '', fillable: true };
    case 'rect': {
      const x = len(el, 'x');
      const y = len(el, 'y');
      const w = len(el, 'width');
      const h = len(el, 'height');
      if (w <= 0 || h <= 0) return null;
      const rxAttr = el.getAttribute('rx');
      const ryAttr = el.getAttribute('ry');
      let rx = rxAttr !== null && rxAttr !== 'auto' ? len(el, 'rx') : NaN;
      let ry = ryAttr !== null && ryAttr !== 'auto' ? len(el, 'ry') : NaN;
      if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry;
      if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) return { d: `M${x} ${y}H${x + w}V${y + h}H${x}Z`, fillable: true };
      return {
        d:
          `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
          `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
          `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`,
        fillable: true
      };
    }
    case 'circle':
    case 'ellipse': {
      const cx = len(el, 'cx');
      const cy = len(el, 'cy');
      const rx = el.localName === 'circle' ? len(el, 'r') : len(el, 'rx');
      const ry = el.localName === 'circle' ? rx : len(el, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return {
        d: `M${cx + rx} ${cy}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}Z`,
        fillable: true
      };
    }
    case 'line':
      return { d: `M${len(el, 'x1')} ${len(el, 'y1')}L${len(el, 'x2')} ${len(el, 'y2')}`, fillable: false };
    case 'polyline':
    case 'polygon': {
      const pts = parseNumberList(el.getAttribute('points'));
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return { d: el.localName === 'polygon' ? d + 'Z' : d, fillable: true };
    }
    default:
      return null;
  }
};

const len = (el: Element, name: string) => {
  const v = parseFloat(el.getAttribute(name) ?? '');
  return Number.isFinite(v) ? v : 0;
};

const numberOr = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  const v = value.trim().endsWith('%') ? parseFloat(value) / 100 : parseFloat(value);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
};

/** gradients are reduced to the average of their stops, patterns and other paint servers to grey */
const gradientColor = (el: Element | undefined): RGBA | null => {
  if (!el) return null;
  if (el.localName !== 'linearGradient' && el.localName !== 'radialGradient') return [0.5, 0.5, 0.5, 1];
  const stops = Array.from(el.getElementsByTagName('stop'));
  if (!stops.length) return null;
  const sum: RGBA = [0, 0, 0, 0];
  for (const stop of stops) {
    const decl = parseDeclarations(stop.getAttribute('style') ?? '');
    const c = parseColor(decl['stop-color'] ?? stop.getAttribute('stop-color') ?? 'black') ?? [0, 0, 0, 0];
    const a = numberOr(decl['stop-opacity'] ?? stop.getAttribute('stop-opacity') ?? undefined, 1);
    for (let i = 0; i < 3; i++) sum[i] += c[i];
    sum[3] += c[3] * a;
  }
  return sum.map((v) => v / stops.length) as RGBA;
};

const parseDeclarations = (text: string): Style => {
  const out: Style = {};
  for (const decl of text.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim().toLowerCase();
    const value = decl
      .slice(i + 1)
      .replace(/!important/i, '')
      .trim();
    if (name && value) out[name] = value;
  }
  return out;
};

const specificity = (selector: string) => {
  const ids = (selector.match(/#/g) ?? []).length;
  const classes = (selector.match(/\./g) ?? []).length;
  const tag = /^[a-zA-Z]/.test(selector) ? 1 : 0;
  return ids * 100 + classes * 10 + tag;
};

/** simple rules only: `tag`, `.class`, `#id` and compounds like `path.land`; anything fancier is skipped */
const collectCssRules = (doc: Document): CssRule[] => {
  const rules: CssRule[] = [];
  let order = 0;
  for (const styleEl of Array.from(doc.getElementsByTagName('style'))) {
    const css = (styleEl.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^}]*)\}/g;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      const declarations = parseDeclarations(m[2]);
      for (const raw of m[1].split(',')) {
        const selector = raw.trim();
        if (!/^[a-zA-Z*]?[\w-]*([.#][\w-]+)*$/.test(selector) || !selector) continue;
        rules.push({ selector, specificity: specificity(selector), order: order++, declarations });
      }
    }
  }
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
};

const matches = (el: Element, selector: string) => {
  const parts = selector.match(/^([a-zA-Z*][\w-]*)?(.*)$/);
  if (!parts) return false;
  const [, tag, rest] = parts;
  if (tag && tag !== '*' && tag !== el.localName) return false;
  const classes = (el.getAttribute('class') ?? '').split(/\s+/);
  for (const token of rest.match(/[.#][\w-]+/g) ?? []) {
    if (token[0] === '.' && !classes.includes(token.slice(1))) return false;
    if (token[0] === '#' && el.getAttribute('id') !== token.slice(1)) return false;
  }
  return true;
};

const rootBounds = (root: Element): Bounds | null => {
  const vb = parseNumberList(root.getAttribute('viewBox'));
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0)
    return { minX: vb[0], minY: vb[1], maxX: vb[0] + vb[2], maxY: vb[1] + vb[3] };
  const w = parseFloat(root.getAttribute('width') ?? '');
  const h = parseFloat(root.getAttribute('height') ?? '');
  const percent = /%/.test((root.getAttribute('width') ?? '') + (root.getAttribute('height') ?? ''));
  if (w > 0 && h > 0 && !percent) return { minX: 0, minY: 0, maxX: w, maxY: h };
  return null;
};

/** bounds of all control points, a slight overestimate for curves */
export const geometryBounds = (shapes: GeometryShape[]): Bounds => {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number) => {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  };
  for (const shape of shapes)
    for (const sp of shape.subpaths) {
      add(sp.x, sp.y);
      for (const s of sp.segments) {
        add(s.x, s.y);
        if (s.type !== 'L') add(s.x1, s.y1);
        if (s.type === 'C') add(s.x2, s.y2);
      }
    }
  if (!Number.isFinite(b.minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  if (b.maxX === b.minX) b.maxX += 1;
  if (b.maxY === b.minY) b.maxY += 1;
  return b;
};

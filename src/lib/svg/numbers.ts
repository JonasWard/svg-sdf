/** Reads svg number lists: commas or whitespace as separators, and numbers glued together like `1.5.5-2` or `1e-3`. */
export class NumberScanner {
  private pos = 0;

  constructor(private readonly text: string) {}

  get done() {
    this.skipSeparators();
    return this.pos >= this.text.length;
  }

  /** the next non-separator character without consuming it */
  peek(): string {
    this.skipSeparators();
    return this.text[this.pos] ?? '';
  }

  /** consumes one character */
  next(): string {
    this.skipSeparators();
    return this.text[this.pos++] ?? '';
  }

  isNumberStart() {
    const c = this.peek();
    return (c >= '0' && c <= '9') || c === '.' || c === '-' || c === '+';
  }

  number(): number {
    this.skipSeparators();
    const start = this.pos;
    const t = this.text;
    if (t[this.pos] === '+' || t[this.pos] === '-') this.pos++;
    while (isDigit(t[this.pos])) this.pos++;
    if (t[this.pos] === '.') {
      this.pos++;
      while (isDigit(t[this.pos])) this.pos++;
    }
    if (this.pos > start && (t[this.pos] === 'e' || t[this.pos] === 'E')) {
      const save = this.pos;
      this.pos++;
      if (t[this.pos] === '+' || t[this.pos] === '-') this.pos++;
      if (isDigit(t[this.pos])) while (isDigit(t[this.pos])) this.pos++;
      else this.pos = save;
    }
    const value = Number(t.slice(start, this.pos));
    if (this.pos === start || Number.isNaN(value)) throw new Error(`expected a number at ${start} in "${t}"`);
    return value;
  }

  /** an arc flag, a single 0 or 1 that may be glued to what follows */
  flag(): boolean {
    const c = this.next();
    if (c !== '0' && c !== '1') throw new Error(`expected an arc flag at ${this.pos - 1} in "${this.text}"`);
    return c === '1';
  }

  private skipSeparators() {
    const t = this.text;
    while (this.pos < t.length && (t[this.pos] === ',' || isSpace(t[this.pos]))) this.pos++;
  }
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/** all numbers in a string, used for points, viewBox and the like */
export const parseNumberList = (text: string | null | undefined): number[] => {
  if (!text) return [];
  const scanner = new NumberScanner(text);
  const out: number[] = [];
  try {
    while (!scanner.done) out.push(scanner.number());
  } catch {
    // svg renders everything up to the first error, so do we
  }
  return out;
};

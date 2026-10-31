/** Appends bits most significant first. The buffer is a string of "0" and "1" characters. */
export class BitWriter {
  #bits = '';

  get length(): number {
    return this.#bits.length;
  }

  /** Appends `value` as an unsigned `width`-bit number. Throws RangeError if it does not fit. */
  write(value: number | bigint, width: number): void {
    const v = BigInt(value);
    if (width < 1 || v < 0n || v >= 1n << BigInt(width)) {
      throw new RangeError(`${v} does not fit in ${width} bits`);
    }
    this.#bits += v.toString(2).padStart(width, '0');
  }

  toString(): string {
    return this.#bits;
  }
}

/** Reads bits most significant first from a "0"/"1" string. */
export class BitReader {
  readonly #bits: string;
  #pos = 0;

  constructor(bits: string) {
    this.#bits = bits;
  }

  get position(): number {
    return this.#pos;
  }

  get remaining(): number {
    return this.#bits.length - this.#pos;
  }

  #take(width: number): string {
    if (width > this.remaining)
      throw new RangeError(`Need ${width} bits, ${this.remaining} remain`);
    const s = this.#bits.slice(this.#pos, this.#pos + width);
    this.#pos += width;
    return s;
  }

  /** Reads an unsigned number of at most 32 bits. */
  read(width: number): number {
    return width === 0 ? 0 : Number.parseInt(this.#take(width), 2);
  }

  readBig(width: number): bigint {
    return width === 0 ? 0n : BigInt(`0b${this.#take(width)}`);
  }

  /** The unread bits, without consuming them. */
  rest(): string {
    return this.#bits.slice(this.#pos);
  }
}

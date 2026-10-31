import { Gs1Error, fail, isDigits, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import type { ElementString } from '../../ai/index.ts';
import { freezePattern, notRepresentable } from '../render/internal.ts';
import type { HriText, LinearPattern, PatternRow, SymbologyName } from '../render/index.ts';
import {
  ADDON2_PARITY,
  ADDON5_PARITY,
  ADDON_DELINEATOR,
  ADDON_GUARD,
  CENTRE_GUARD,
  EAN13_PARITY,
  NORMAL_GUARD,
  SET_A,
  SET_B,
  UPCE_GUARD,
  UPCE_PARITY,
} from './ean-tables.ts';
import { gtinInput } from './gtin-input.ts';
import { upceCompress } from './upce.ts';

/** The tallest bars, in modules: far above any real symbol, it keeps rendered images sane. */
const MAX_HEIGHT = 1000;

export type EanUpcForm = 'ean-13' | 'upc-a' | 'ean-8' | 'upc-e';

export interface EanUpcOptions {
  /** 2 or 5 digits (EAN-13, UPC-A and UPC-E only). */
  readonly addOn?: string;
  /** Modules between the main symbol and the add-on: the form's default up to 12. */
  readonly addOnGap?: number;
  /** Main bar height in modules (default 69, EAN-8 55). */
  readonly height?: number;
  /** Human readable digits (default true). */
  readonly hri?: boolean;
  /** Light margin indicators `<` and `>` (default true). */
  readonly quietZoneMarkers?: boolean;
}

const GUARD_EXTENSION = 5;
const ADDON_TOP = 8;
const HRI_BELOW = 9;
const ADDON_BASELINE = 7.5;
const FONT = 11;
const SMALL_FONT = 8;

interface Geometry {
  readonly mainWidth: number;
  readonly defaultHeight: number;
  readonly defaultGap: number;
  readonly left: number;
  readonly right: number;
  readonly extended: readonly number[];
}

const GEOMETRY: Readonly<Record<EanUpcForm, Geometry>> = {
  'ean-13': {
    mainWidth: 95,
    defaultHeight: 69,
    defaultGap: 7,
    left: 11,
    right: 7,
    extended: [0, 2, 28, 30, 56, 58],
  },
  'upc-a': {
    mainWidth: 95,
    defaultHeight: 69,
    defaultGap: 9,
    left: 9,
    right: 9,
    extended: [0, 2, 4, 6, 28, 30, 52, 54, 56, 58],
  },
  'ean-8': {
    mainWidth: 67,
    defaultHeight: 55,
    defaultGap: 7,
    left: 7,
    right: 7,
    extended: [0, 2, 20, 22, 40, 42],
  },
  'upc-e': {
    mainWidth: 51,
    defaultHeight: 69,
    defaultGap: 7,
    left: 9,
    right: 7,
    extended: [0, 2, 28, 30, 32],
  },
};

const MAX_GAP = 12;

function invalidOption(option: string, message: string): Gs1Error {
  return new Gs1Error({ code: 'INVALID_VALUE', message, details: { option } });
}

function digit(s: string, i: number): number {
  return s.charCodeAt(i) - 48;
}

/** Appends the element widths of one symbol character. */
function pushChar(out: number[], table: readonly string[], d: number): void {
  const w = table[d] ?? '';
  for (let i = 0; i < w.length; i++) out.push(w.charCodeAt(i) - 48);
}

function pushAll(out: number[], widths: readonly number[]): void {
  for (const w of widths) out.push(w);
}

function pushHalf(out: number[], digits: string, from: number, to: number, parity: string): void {
  for (let i = from; i < to; i++)
    pushChar(out, parity.charCodeAt(i - from) === 65 ? SET_A : SET_B, digit(digits, i));
}

/** Element widths of the main symbol, given the digits as listed per form. */
function mainWidths(form: EanUpcForm, d: string, upceBody: string): number[] {
  const out: number[] = [];
  pushAll(out, NORMAL_GUARD);
  if (form === 'upc-e') {
    pushHalf(out, upceBody, 0, 6, UPCE_PARITY[digit(d, 11)] ?? '');
    pushAll(out, UPCE_GUARD);
    return out;
  }
  if (form === 'ean-8') {
    pushHalf(out, d, 0, 4, 'AAAA');
    pushAll(out, CENTRE_GUARD);
    for (let i = 4; i < 8; i++) pushChar(out, SET_A, digit(d, i));
  } else {
    // EAN-13 digits (UPC-A is 0 + its 12 digits)
    pushHalf(out, d, 1, 7, EAN13_PARITY[digit(d, 0)] ?? '');
    pushAll(out, CENTRE_GUARD);
    for (let i = 7; i < 13; i++) pushChar(out, SET_A, digit(d, i));
  }
  pushAll(out, NORMAL_GUARD);
  return out;
}

/** Element widths of a 2 or 5 digit add-on (GenSpecs 5.2.2.5). */
function addOnWidths(addOn: string): number[] {
  const out: number[] = [];
  let parity: string;
  if (addOn.length === 2) {
    parity = ADDON2_PARITY[(digit(addOn, 0) * 10 + digit(addOn, 1)) % 4] ?? '';
  } else {
    const v =
      (3 * (digit(addOn, 0) + digit(addOn, 2) + digit(addOn, 4)) +
        9 * (digit(addOn, 1) + digit(addOn, 3))) %
      10;
    parity = ADDON5_PARITY[v] ?? '';
  }
  pushAll(out, ADDON_GUARD);
  for (let i = 0; i < addOn.length; i++) {
    if (i > 0) pushAll(out, ADDON_DELINEATOR);
    pushChar(out, parity.charCodeAt(i) === 65 ? SET_A : SET_B, digit(addOn, i));
  }
  return out;
}

/** The main widths with only the elements at `extended` dark, the rest folded into light runs. */
function extensionWidths(widths: readonly number[], extended: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i] ?? 0;
    const dark = extended.includes(i);
    const lastDark = out.length % 2 === 1;
    if (out.length === 0 && !dark) out.push(0, w);
    else if (out.length > 0 && lastDark === dark) out[out.length - 1] = (out.at(-1) ?? 0) + w;
    else out.push(w);
  }
  return out;
}

function text(t: string, x: number, y: number, size: number, anchor: HriText['anchor']): HriText {
  return { text: t, x, y, size, anchor, role: 'hri' };
}

function marker(t: string, x: number, y: number, anchor: HriText['anchor']): HriText {
  return { text: t, x, y, size: FONT, anchor, role: 'quiet-zone-marker' };
}

const mid = (x: number, i: number): number => x + 7 * i + 3.5;

function mainHri(form: EanUpcForm, d: string, upceBody: string, y: number): HriText[] {
  const out: HriText[] = [];
  if (form === 'ean-13') {
    out.push(text(d.charAt(0), -4, y, FONT, 'end'));
    for (let i = 0; i < 6; i++) out.push(text(d.charAt(1 + i), mid(3, i), y, FONT, 'middle'));
    for (let i = 0; i < 6; i++) out.push(text(d.charAt(7 + i), mid(50, i), y, FONT, 'middle'));
  } else if (form === 'upc-a') {
    out.push(text(d.charAt(1), -5, y, SMALL_FONT, 'end'));
    for (let i = 1; i < 6; i++) out.push(text(d.charAt(1 + i), mid(3, i), y, FONT, 'middle'));
    for (let i = 0; i < 5; i++) out.push(text(d.charAt(7 + i), mid(50, i), y, FONT, 'middle'));
    out.push(text(d.charAt(12), 95 + 5, y, SMALL_FONT, 'start'));
  } else if (form === 'ean-8') {
    for (let i = 0; i < 4; i++) out.push(text(d.charAt(i), mid(3, i), y, FONT, 'middle'));
    for (let i = 0; i < 4; i++) out.push(text(d.charAt(4 + i), mid(36, i), y, FONT, 'middle'));
  } else {
    out.push(text('0', -5, y, SMALL_FONT, 'end'));
    for (let i = 0; i < 6; i++) out.push(text(upceBody.charAt(i), mid(3, i), y, FONT, 'middle'));
    out.push(text(d.charAt(11), 51 + 3, y, SMALL_FONT, 'start'));
  }
  return out;
}

interface Settings {
  readonly addOn: string | undefined;
  readonly gap: number | undefined;
  readonly height: number | undefined;
  readonly hri: boolean;
  readonly markers: boolean;
}

function readOptions(form: EanUpcForm, options: unknown): Result<Settings> {
  if (options !== undefined && (typeof options !== 'object' || options === null))
    return fail([invalidOption('options', 'Options must be an object')]);
  const o: object = options ?? {};
  const get = (name: string): unknown => Reflect.get(o, name);
  const errors: Gs1Error[] = [];
  const geo = GEOMETRY[form];
  let addOn: string | undefined;
  if (get('addOn') !== undefined) {
    const a = get('addOn');
    if (typeof a !== 'string' || (a.length !== 2 && a.length !== 5) || !isDigits(a))
      errors.push(invalidOption('addOn', 'addOn must be 2 or 5 digits'));
    else addOn = a;
  }
  let gap: number | undefined;
  if (get('addOnGap') !== undefined) {
    const g = get('addOnGap');
    if (typeof g !== 'number' || !Number.isInteger(g) || g < geo.defaultGap || g > MAX_GAP)
      errors.push(invalidOption('addOnGap', `addOnGap must be ${geo.defaultGap} to ${MAX_GAP}`));
    else gap = g;
  }
  let height: number | undefined;
  if (get('height') !== undefined) {
    const h = get('height');
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_HEIGHT)
      errors.push(invalidOption('height', `height must be above 0 and at most ${MAX_HEIGHT}`));
    else height = h;
  }
  const flag = (name: string): boolean => {
    const v = get(name);
    if (v === undefined) return true;
    if (typeof v !== 'boolean') {
      errors.push(invalidOption(name, `${name} must be a boolean`));
      return true;
    }
    return v;
  };
  const hri = flag('hri');
  const markers = flag('quietZoneMarkers');
  if (errors.length > 0) return fail(errors);
  return ok({ addOn, gap, height, hri, markers });
}

/** The digits to encode, or the reason the GTIN-14 cannot be carried by `form`. */
function representable(form: EanUpcForm, gtin14: string): Result<{ d: string; body: string }> {
  const sym: SymbologyName = form;
  const need =
    form === 'ean-13' ? '0' : form === 'upc-a' ? '00' : form === 'ean-8' ? '000000' : '000';
  if (!gtin14.startsWith(need))
    return fail([notRepresentable(sym, `the GTIN-14 must start with ${need}`)]);
  if (form !== 'ean-8') {
    const g13 = gtin14.slice(1);
    if (g13.startsWith('00000') && g13.slice(5, 7) !== '00')
      return fail([
        notRepresentable(sym, 'the 13-digit value is in the unused GTIN-8 range (00000 + GTIN-8)'),
      ]);
  }
  if (form === 'ean-13') return ok({ d: gtin14.slice(1), body: '' });
  if (form === 'upc-a') return ok({ d: gtin14.slice(1), body: '' });
  if (form === 'ean-8') return ok({ d: gtin14.slice(6), body: '' });
  const gtin12 = gtin14.slice(2);
  const body = upceCompress(gtin12);
  if (body === undefined)
    return fail([notRepresentable(sym, 'the GTIN-12 cannot be zero-suppressed to UPC-E')]);
  return ok({ d: gtin12, body });
}

function build(form: EanUpcForm, d: string, body: string, s: Settings): LinearPattern {
  const geo = GEOMETRY[form];
  const height = s.height ?? geo.defaultHeight;
  const main = mainWidths(form, d, body);
  const ext = extensionWidths(main, geo.extended);
  const rows: PatternRow[] = [
    { role: 'symbol', x: 0, y: 0, height, widths: main },
    { role: 'guard-extension', x: 0, y: height, height: GUARD_EXTENSION, widths: ext },
  ];
  let width = geo.mainWidth;
  const baseline = height + HRI_BELOW;
  const hri: HriText[] = [];
  if (s.hri) {
    if (form === 'ean-8' && s.markers) hri.push(marker('<', -7, baseline, 'start'));
    hri.push(...mainHri(form, d, body, baseline));
  }
  if (s.addOn !== undefined) {
    const x = geo.mainWidth + (s.gap ?? geo.defaultGap);
    const widths = addOnWidths(s.addOn);
    const aw = s.addOn.length === 2 ? 20 : 47;
    rows.push({
      role: 'add-on',
      x,
      y: ADDON_TOP,
      height: height + GUARD_EXTENSION - ADDON_TOP,
      widths,
    });
    width = x + aw;
    if (s.hri)
      for (let i = 0; i < s.addOn.length; i++)
        hri.push(text(s.addOn.charAt(i), x + 4 + 9 * i + 3.5, ADDON_BASELINE, FONT, 'middle'));
  }
  const right = s.addOn === undefined ? geo.right : 5;
  if (s.hri && s.markers && (form === 'ean-13' || form === 'ean-8' || s.addOn !== undefined))
    hri.push(marker('>', width + right, baseline, 'end'));
  return freezePattern({
    kind: 'linear',
    symbology: form,
    width,
    height: height + GUARD_EXTENSION + (s.hri ? HRI_BELOW : 0),
    rows,
    hri,
    quietZone: { left: geo.left, right, top: 0, bottom: 0 },
  });
}

/**
 * Encodes a GTIN as EAN-13, UPC-A, EAN-8 or UPC-E, with an optional 2 or 5 digit add-on
 * (plan decisions G6, G7, G11, G16, G17). Never throws.
 */
export function encodeEanUpc(
  form: EanUpcForm,
  data: ElementString | string,
  options?: EanUpcOptions,
): Result<LinearPattern> {
  try {
    if (!Object.hasOwn(GEOMETRY, form))
      return fail([invalidOption('form', 'Unknown EAN/UPC form')]);
    const opts = readOptions(form, options);
    if (!opts.ok) return fail(opts.errors);
    const gtin = gtinInput(data, form);
    if (!gtin.ok) return fail(gtin.errors);
    const rep = representable(form, gtin.value);
    if (!rep.ok) return fail(rep.errors);
    if (opts.value.addOn !== undefined && form === 'ean-8')
      return fail([notRepresentable(form, 'EAN-8 has no add-on')]);
    return ok(build(form, rep.value.d, rep.value.body, opts.value));
  } catch {
    return fail([new Gs1Error({ code: 'INVALID_VALUE', message: 'Input could not be encoded' })]);
  }
}

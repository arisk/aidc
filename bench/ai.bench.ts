import { describe, expect, test } from 'vitest';
import { format, parse } from 'aidc';

const BRACKETED = '(01)09506000134352(17)201225(10)ABC123(21)XYZ987654';
const RAW = '01095060001343521720122510ABC123\u001d21XYZ987654';
const es = parse(BRACKETED);

describe('element strings', () => {
  test('parse and format', async ({ bench }) => {
    expect(format(parse(RAW), 'bracketed')).toBe(BRACKETED);
    await bench.compare(
      bench('parse bracketed', () => {
        parse(BRACKETED);
      }),
      bench('parse raw', () => {
        parse(RAW);
      }),
      bench('format raw', () => {
        format(es, 'raw');
      }),
    );
  });
});

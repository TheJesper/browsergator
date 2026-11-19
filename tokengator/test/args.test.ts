import { describe, expect, it } from 'vitest';

import { ArgError, integerFlag, parseArgs } from '../src/cli/args.js';

const spec = { values: ['port', 'host', 'only'], switches: ['json', 'no-color', 'dry-run'], short: { j: 'json', p: 'port' } };

describe('parseArgs', () => {
  it('reads switches, both value forms and positionals in any order', () => {
    const parsed = parseArgs(['first', '--json', '--port', '4777', 'second', '--host=127.0.0.1', '--no-color'], spec);
    expect(parsed.positionals).toEqual(['first', 'second']);
    expect([...parsed.switches].sort()).toEqual(['json', 'no-color']);
    expect(parsed.values.get('port')).toBe('4777');
    expect(parsed.values.get('host')).toBe('127.0.0.1');
    expect(parsed.rest).toEqual([]);
  });

  it('keeps an equals sign that belongs to the value, and allows an empty value', () => {
    const parsed = parseArgs(['--only=a=b,c', '--host='], spec);
    expect(parsed.values.get('only')).toBe('a=b,c');
    expect(parsed.values.get('host')).toBe('');
  });

  it('lets the last occurrence of a value flag win', () => {
    expect(parseArgs(['--port', '1', '--port=2'], spec).values.get('port')).toBe('2');
  });

  it('passes everything after a bare -- through untouched', () => {
    const parsed = parseArgs(['one', '--json', '--', '--port', 'x', '--unknown', '--'], spec);
    expect(parsed.positionals).toEqual(['one']);
    expect(parsed.switches.has('json')).toBe(true);
    expect(parsed.values.has('port')).toBe(false);
    expect(parsed.rest).toEqual(['--port', 'x', '--unknown', '--']);
  });

  it('does not let a switch swallow the word after it', () => {
    const parsed = parseArgs(['--json', 'claude'], spec);
    expect(parsed.switches.has('json')).toBe(true);
    expect(parsed.positionals).toEqual(['claude']);
  });

  it('accepts single-letter aliases, with a value when the flag takes one', () => {
    const parsed = parseArgs(['-j', '-p', '9000'], spec);
    expect(parsed.switches.has('json')).toBe(true);
    expect(parsed.values.get('port')).toBe('9000');
  });

  it('treats a lone dash and a negative number as ordinary words', () => {
    expect(parseArgs(['-', '-5', '-12.5%'], spec).positionals).toEqual(['-', '-5', '-12.5%']);
    expect(parseArgs(['--port', '-1'], spec).values.get('port')).toBe('-1');
  });

  it('rejects what it does not know, naming it', () => {
    expect(() => parseArgs(['--nope'], spec)).toThrow(new ArgError('Unknown option --nope.'));
    expect(() => parseArgs(['--nope=1'], spec)).toThrow('Unknown option --nope.');
    expect(() => parseArgs(['-x'], spec)).toThrow('Unknown option -x.');
    expect(() => parseArgs(['--json'])).toThrow(ArgError);
  });

  it('rejects a value flag without a value', () => {
    expect(() => parseArgs(['--port'], spec)).toThrow('--port needs a value.');
    expect(() => parseArgs(['--port', '--json'], spec)).toThrow('--port needs a value.');
    expect(() => parseArgs(['-p'], spec)).toThrow('-p needs a value.');
  });

  it('rejects a value given to a switch', () => {
    expect(() => parseArgs(['--json=yes'], spec)).toThrow('--json does not take a value.');
  });

  it('returns empty collections for no arguments', () => {
    const parsed = parseArgs([]);
    expect(parsed).toEqual({ positionals: [], values: new Map(), switches: new Set(), rest: [] });
  });
});

describe('integerFlag', () => {
  it('returns undefined when the flag is absent and the number when it is valid', () => {
    expect(integerFlag(parseArgs([], spec), 'port', 0, 65_535)).toBeUndefined();
    expect(integerFlag(parseArgs(['--port', '0'], spec), 'port', 0, 65_535)).toBe(0);
    expect(integerFlag(parseArgs(['--port=4777'], spec), 'port', 0, 65_535)).toBe(4777);
  });

  it.each(['abc', '', '-1', '70000', '47.5', '1e3', '0x10'])('rejects %j with a message that names the flag', (raw) => {
    expect(() => integerFlag(parseArgs([`--port=${raw}`], spec), 'port', 0, 65_535)).toThrow(/--port must be a whole number from 0 to 65535/);
  });
});

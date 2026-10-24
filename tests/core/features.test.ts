import { describe, expect, it } from 'vitest';
import type { RawCandidate } from '../../src/core/finding.ts';
import {
  ENTROPY_BUCKETS,
  LENGTH_BUCKETS,
  classifyChars,
  classifyPath,
  computeFeatures,
  entropyBucket,
  entropyThreshold,
  isCommitShape,
  isDataUriBase64,
  isIdentifierShape,
  isPathLike,
  isUuidShape,
  lengthBucket,
  pemInfo,
  shannonEntropy,
} from '../../src/core/features/index.ts';
import { HEX, fakeGenericToken, randomChars, rng } from './_helpers.ts';

const r = rng(505);

describe('shannonEntropy', () => {
  it('matches hand-calculable values', () => {
    expect(shannonEntropy('')).toBe(0);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('ab')).toBeCloseTo(1, 10);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 10);
    expect(shannonEntropy('aabb')).toBeCloseTo(1, 10);
  });
});

describe('classifyChars', () => {
  it('assigns the documented classes', () => {
    expect(classifyChars('0123456789')).toBe('digits');
    expect(classifyChars('deadbeef0123')).toBe('hex');
    expect(classifyChars('Abc123Xyz')).toBe('alnum');
    expect(classifyChars('Ab+c/12==')).toBe('base64');
    expect(classifyChars('Ab-c_12')).toBe('base64url');
    expect(classifyChars('has space!')).toBe('mixed');
    expect(classifyChars(['-----BEGIN', ' RSA PRIVATE KEY-----'].join('') + '\nabc')).toBe('pem');
  });
});

describe('classifyPath', () => {
  it('lockfile, fixture, test, docs, config, source, other', () => {
    expect(classifyPath('web/package-lock.json')).toBe('lockfile');
    expect(classifyPath('tests/fixtures/keys.json')).toBe('fixture');
    expect(classifyPath('src/__tests__/auth.ts')).toBe('test');
    expect(classifyPath('src/auth.test.ts')).toBe('test');
    expect(classifyPath('pkg/auth_test.go')).toBe('test');
    expect(classifyPath('docs/setup.md')).toBe('docs');
    expect(classifyPath('README.md')).toBe('docs');
    expect(classifyPath('deploy/.env.production')).toBe('config');
    expect(classifyPath('config/app.yaml')).toBe('config');
    expect(classifyPath('src\\server\\db.ts')).toBe('source');
    expect(classifyPath('assets/logo.png')).toBe('other');
    expect(classifyPath('')).toBe('other');
  });
});

describe('buckets', () => {
  it('length buckets use the exported boundaries', () => {
    expect(LENGTH_BUCKETS.map((b) => b.max)).toEqual([8, 16, 32, 64]);
    expect(lengthBucket(8)).toBe('xs');
    expect(lengthBucket(9)).toBe('s');
    expect(lengthBucket(16)).toBe('s');
    expect(lengthBucket(32)).toBe('m');
    expect(lengthBucket(64)).toBe('l');
    expect(lengthBucket(65)).toBe('xl');
  });

  it('entropy buckets use the exported boundaries', () => {
    expect(entropyBucket(ENTROPY_BUCKETS.LOW_BELOW - 0.01)).toBe('low');
    expect(entropyBucket(ENTROPY_BUCKETS.LOW_BELOW)).toBe('mid');
    expect(entropyBucket(ENTROPY_BUCKETS.HIGH_FROM)).toBe('high');
    expect(entropyBucket(Number.NaN)).toBe('low');
  });

  it('entropy threshold is length-aware and never above the class base', () => {
    expect(entropyThreshold('base64', 1000)).toBe(4.0);
    expect(entropyThreshold('alnum', 16)).toBeCloseTo(0.85 * 4, 10);
    expect(entropyThreshold('hex', 40)).toBe(3.0);
  });
});

describe('shapes', () => {
  it('uuid, commit, data URI, PEM, identifier, path', () => {
    expect(isUuidShape('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isCommitShape(randomChars(r, 40, HEX))).toBe(true);
    expect(isCommitShape(randomChars(r, 39, HEX))).toBe(false);
    expect(isDataUriBase64('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    const header = ['-----BEGIN', ' RSA PRIVATE KEY-----'].join('');
    const footer = ['-----END', ' RSA PRIVATE KEY-----'].join('');
    expect(pemInfo(`${header}\n...\n${footer}`).elided).toBe(true);
    const body = [fakeGenericToken(r, 64), fakeGenericToken(r, 64)].join('\n');
    const full = pemInfo(`${header}\n${body}\n${footer}`);
    expect(full.hasHeader).toBe(true);
    expect(full.elided).toBe(false);
    expect(full.bodyChars).toBe(128);
    expect(isIdentifierShape('getUserAccountSettings')).toBe(true);
    expect(isIdentifierShape('MY_SECRET_KEY_NAME')).toBe(true);
    expect(isIdentifierShape(fakeGenericToken(r, 32))).toBe(false);
    expect(isPathLike('src/components/LoginButton')).toBe(true);
    expect(isPathLike(fakeGenericToken(r, 10) + '/' + fakeGenericToken(r, 10))).toBe(false);
  });
});

describe('computeFeatures', () => {
  it('computes entropy in code and never uses scanner entropy', () => {
    const value = fakeGenericToken(r, 40);
    const raw: RawCandidate = {
      scanner: 'gitleaks',
      ruleId: 'generic-api-key',
      path: 'tests/fixtures/x.json',
      line: 1,
      rawValue: value,
      scannerEntropy: 99,
      recordIndex: 0,
    };
    const f = computeFeatures(raw);
    expect(f.entropy).toBeCloseTo(shannonEntropy(value), 10);
    expect(f.entropy).not.toBe(99);
    expect(f.length).toBe(40);
    expect(f.charClass).toBe('alnum');
    expect(f.lengthBucket).toBe('l');
    expect(f.pathClass).toBe('fixture');
    expect(JSON.stringify(f)).not.toContain(value.slice(0, 6));
  });
});

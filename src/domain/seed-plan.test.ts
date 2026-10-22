import { describe, expect, it } from 'vitest';
import { planProductImages } from './seed-plan';

const keys = (...k: Array<string | null>) => k.map((seedKey) => ({ seedKey }));

describe('planProductImages', () => {
  it('attaches every image of a product that has none yet', () => {
    expect(planProductImages('noir-salt-30', 2, [])).toEqual({ attach: [0, 1], status: 'resume' });
  });

  it('resumes after an interrupted seed: first image attached, second missing', () => {
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/0'))).toEqual({ attach: [1], status: 'resume' });
  });

  it('adds nothing once all images are attached (repeated re-seed creates no duplicates)', () => {
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/1', 'img:noir-salt-30/0'))).toEqual({
      attach: [],
      status: 'complete',
    });
  });

  it('leaves owner-managed photos alone: own images, gaps, foreign or out-of-range keys', () => {
    const managed = { attach: [], status: 'owner_managed' };
    expect(planProductImages('noir-salt-30', 2, keys(null))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/0', null))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 3, keys('img:noir-salt-30/1'))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:velvet-ice/0'))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/2'))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/01'))).toEqual(managed);
    // Key of a product whose key extends this one must not be mistaken for its own.
    expect(planProductImages('noir', 1, keys('img:noir-salt-30/0'))).toEqual(managed);
  });

  it('a product without config images needs nothing', () => {
    expect(planProductImages('lanyard', 0, [])).toEqual({ attach: [], status: 'complete' });
  });
});

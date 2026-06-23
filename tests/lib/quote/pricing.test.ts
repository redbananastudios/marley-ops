import { describe, expect, it } from 'vitest';
import {
  computeQuote,
  getAccessCharge,
  getFloorCharge,
  DEFAULT_PRICING,
  type PricingConfig,
  type QuoteInputs,
} from '@/lib/quote/pricing';

/**
 * Money-core lock. Expected grand totals are hand-computed from the verbatim arithmetic
 * in the live MM Quotes engine (admin fee +£150 in every subtotal; VAT only when on).
 * If any of these change, pricing has drifted from the live tool — STOP.
 */

function base(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    vehicle: '1luton',
    packing: 'owner',
    has75T: false,
    deadMiles: null,
    jobMiles: null,
    collectAccessM: 0,
    destAccessM: 0,
    collectType: 'house',
    collectFloor: 'ground',
    destType: 'house',
    destFloor: 'ground',
    congestion: false,
    tolls: 0,
    parking: 0,
    discount: 0,
    vatEnabled: false,
    ...overrides,
  };
}

describe('computeQuote — golden scenarios (pinned to the live tool)', () => {
  it('1. base 1-van owner, no extras', () => {
    const q = computeQuote(base());
    expect(q.subtotal).toBe(850); // 700 + 150 admin
    expect(q.grandTotal).toBe(850);
  });

  it('2. 2-van base', () => {
    expect(computeQuote(base({ vehicle: '2luton' })).grandTotal).toBe(1500); // 1350 + 150
  });

  it('3. 3-van base', () => {
    expect(computeQuote(base({ vehicle: '3luton' })).grandTotal).toBe(2100); // 1950 + 150
  });

  it('4. 7.5t add-on, owner pack (owner add = 0)', () => {
    expect(computeQuote(base({ has75T: true })).grandTotal).toBe(2450); // 700 + 1600 + 150
  });

  it('5. pack tier — fragile, 1 van', () => {
    expect(computeQuote(base({ packing: 'fragile' })).grandTotal).toBe(1075); // 700 + 225 + 150
  });

  it('6. pack tier — full, 2 van', () => {
    expect(computeQuote(base({ vehicle: '2luton', packing: 'full' })).grandTotal).toBe(2250); // 1350 + 750 + 150
  });

  it('7. 7.5t + full pack, 3 van', () => {
    // 1950 + 995 + 1600 + 1550 + 150
    expect(computeQuote(base({ vehicle: '3luton', packing: 'full', has75T: true })).grandTotal).toBe(6245);
  });

  it('8. mileage (dead 10 + job 20 = 30 × £2)', () => {
    const q = computeQuote(base({ deadMiles: 10, jobMiles: 20 }));
    expect(q.mileageCost).toBe(60);
    expect(q.grandTotal).toBe(910); // 700 + 60 + 150
  });

  it('9. mileage null (not calculated) contributes 0', () => {
    const q = computeQuote(base({ deadMiles: null, jobMiles: null }));
    expect(q.mileageCost).toBeNull();
    expect(q.grandTotal).toBe(850);
  });

  it('10. floors — flat 2nd both ends, 1 van', () => {
    // 700 + (150×1) + (150×1) + 150
    const q = computeQuote(
      base({ collectType: 'flat', collectFloor: '2nd', destType: 'flat', destFloor: '2nd' }),
    );
    expect(q.grandTotal).toBe(1150);
  });

  it('11. floor charge ignored when property is a house', () => {
    expect(computeQuote(base({ collectFloor: '3rd', collectType: 'house' })).grandTotal).toBe(850);
  });

  it('12. floor × vanCount (7.5t bumps vanCount to 3)', () => {
    // 1350 + 1600 + (75 × 3) + 150
    const q = computeQuote(base({ vehicle: '2luton', has75T: true, collectType: 'flat', collectFloor: '1st' }));
    expect(q.vanCount).toBe(3);
    expect(q.grandTotal).toBe(3325);
  });

  it('13. access tiers (15m → £100, 25m → £300)', () => {
    // 700 + 100 + 300 + 150
    expect(computeQuote(base({ collectAccessM: 15, destAccessM: 25 })).grandTotal).toBe(1250);
  });

  it('14. access < 10m is free', () => {
    expect(computeQuote(base({ collectAccessM: 9 })).grandTotal).toBe(850);
  });

  it('15. congestion (per van, 2 van)', () => {
    expect(computeQuote(base({ vehicle: '2luton', congestion: true })).grandTotal).toBe(1540); // 1350 + 40 + 150
  });

  it('16. congestion with 7.5t (vanCount 2)', () => {
    expect(computeQuote(base({ has75T: true, congestion: true })).grandTotal).toBe(2490); // 700 + 1600 + 40 + 150
  });

  it('17. discount before VAT', () => {
    const q = computeQuote(base({ discount: 100 }));
    expect(q.total).toBe(750);
    expect(q.grandTotal).toBe(750);
  });

  it('18. discount clamps at 0 (over-discount)', () => {
    expect(computeQuote(base({ discount: 2000 })).grandTotal).toBe(0);
  });

  it('19. VAT on (base 850 → 1020)', () => {
    expect(computeQuote(base({ vatEnabled: true })).grandTotal).toBe(1020);
  });

  it('20. VAT on after discount (750 × 1.2)', () => {
    expect(computeQuote(base({ discount: 100, vatEnabled: true })).grandTotal).toBe(900);
  });

  it('21. tolls + parking add raw', () => {
    expect(computeQuote(base({ tolls: 15, parking: 8 })).grandTotal).toBe(873); // 850 + 23
  });

  it('22. kitchen sink', () => {
    // base 1950 + pack(full,3)=995 + 75tBase 1600 + 75tPack(full)=1550
    //  + mileage (12.3+47.7=60 × 2 = 120)
    //  + access collect 22→300, dest 11→100
    //  + floor: collect flat 3rd (250×vanCount4=1000), dest flat 1st (75×4=300)
    //  + congestion 4×20=80 + tolls 15 + parking 8 + admin 150
    //  subtotal = 1950+995+1600+1550+120+300+100+1000+300+80+15+8+150 = 8168
    //  total = 8168 − 250 = 7918 ; VAT = 7918 × 0.2 = 1583.6 ; grand = 9501.6
    const q = computeQuote(
      base({
        vehicle: '3luton',
        packing: 'full',
        has75T: true,
        deadMiles: 12.3,
        jobMiles: 47.7,
        collectAccessM: 22,
        destAccessM: 11,
        collectType: 'flat',
        collectFloor: '3rd',
        destType: 'flat',
        destFloor: '1st',
        congestion: true,
        tolls: 15,
        parking: 8,
        discount: 250,
        vatEnabled: true,
      }),
    );
    expect(q.vanCount).toBe(4);
    expect(q.subtotal).toBeCloseTo(8168, 5);
    expect(q.total).toBeCloseTo(7918, 5);
    expect(q.grandTotal).toBeCloseTo(9501.6, 5);
  });
});

describe('computeQuote — invariants', () => {
  it('vatAmount is 0 and grandTotal === total whenever VAT off', () => {
    for (const v of ['1luton', '2luton', '3luton'] as const) {
      for (const p of ['owner', 'fragile', 'full'] as const) {
        const q = computeQuote(base({ vehicle: v, packing: p, discount: 37 }));
        expect(q.vatAmount).toBe(0);
        expect(q.grandTotal).toBe(q.total);
      }
    }
  });

  it('subtotal always includes the £150 admin fee', () => {
    const q = computeQuote(base({ vehicle: '2luton' }));
    expect(q.subtotal).toBeGreaterThanOrEqual(q.base + 150);
    expect(q.adminFee).toBe(150);
  });

  it('total never goes negative', () => {
    expect(computeQuote(base({ discount: 99999 })).total).toBe(0);
  });
});

describe('helpers', () => {
  it('getAccessCharge tiers', () => {
    expect(getAccessCharge(0)).toBe(0);
    expect(getAccessCharge(9)).toBe(0);
    expect(getAccessCharge(10)).toBe(100);
    expect(getAccessCharge(20)).toBe(100);
    expect(getAccessCharge(21)).toBe(300);
  });

  it('getFloorCharge is 0 for houses, per-van for flats', () => {
    expect(getFloorCharge('3rd', false, 3)).toBe(0);
    expect(getFloorCharge('2nd', true, 2)).toBe(300); // 150 × 2
    expect(getFloorCharge('ground', true, 5)).toBe(0);
  });
});

describe('parity snapshot — full breakdown frozen (human-verify vs live before committing)', () => {
  const fixtures: QuoteInputs[] = [
    base(),
    base({ vehicle: '2luton', packing: 'full' }),
    base({ vehicle: '3luton', packing: 'fragile', has75T: true }),
    base({ deadMiles: 8.4, jobMiles: 31.6 }),
    base({ collectType: 'flat', collectFloor: '3rd', destType: 'flat', destFloor: '1st' }),
    base({ collectAccessM: 12, destAccessM: 28, congestion: true }),
    base({ vehicle: '2luton', has75T: true, discount: 200, vatEnabled: true }),
    base({ tolls: 12.5, parking: 6.5, discount: 50 }),
  ];
  it('breakdown shape is stable', () => {
    expect(fixtures.map((f) => computeQuote(f))).toMatchSnapshot();
  });
});

describe('computeQuote — editable price config (margin calculator)', () => {
  it('explicit DEFAULT_PRICING equals the implicit default', () => {
    expect(computeQuote(base({ vehicle: '2luton' }), DEFAULT_PRICING).grandTotal).toBe(
      computeQuote(base({ vehicle: '2luton' })).grandTotal,
    );
  });

  it('overriding a base price flows into the total', () => {
    const pricing: PricingConfig = {
      ...DEFAULT_PRICING,
      base: { ...DEFAULT_PRICING.base, '1luton': 800 },
    };
    // 800 base + 150 admin = 950 (vs the locked 850)
    expect(computeQuote(base(), pricing).grandTotal).toBe(950);
    // the locked default is untouched
    expect(computeQuote(base()).grandTotal).toBe(850);
  });

  it('overriding the mileage rate flows into the total', () => {
    const pricing: PricingConfig = { ...DEFAULT_PRICING, mileageRate: 3 };
    // 700 + 150 + (30 miles × £3) = 940
    expect(computeQuote(base({ deadMiles: 10, jobMiles: 20 }), pricing).grandTotal).toBe(940);
  });
});

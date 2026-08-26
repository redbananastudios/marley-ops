import { describe, expect, it } from "vitest";
import { aggregateEstimators, type EstimatorVisit } from "@/lib/estimator";

const visit = (o: Partial<EstimatorVisit>): EstimatorVisit => ({
  apptId: o.apptId ?? "a",
  estimatorId: "e1",
  estimatorName: "Luke",
  leadId: null,
  customer: "—",
  date: null,
  won: false,
  value: null,
  ...o,
});

describe("aggregateEstimators brand slicing (multi-brand PRD §4 /performance)", () => {
  const visits = [
    visit({ apptId: "a1", brand: "marley", won: true, value: 900 }),
    visit({ apptId: "a2", brand: "marley" }),
    visit({ apptId: "a3", brand: "pitmans", won: true, value: 400 }),
  ];

  it("a named brand counts only that brand's visits; the row stays per-person", () => {
    const [m] = aggregateEstimators(visits, 50, "marley");
    expect(m).toEqual({ id: "e1", name: "Luke", visits: 2, won: 1, winRate: 50, wonValue: 900, fee: 100 });
    const [p] = aggregateEstimators(visits, 50, "pitmans");
    expect(p.visits).toBe(1);
    expect(p.fee).toBe(50);
  });

  it("combined equals the sum of the per-brand slices; undefined and 'all' are identical", () => {
    const [all] = aggregateEstimators(visits, 50);
    expect(aggregateEstimators(visits, 50)).toEqual(aggregateEstimators(visits, 50, "all"));
    const [m] = aggregateEstimators(visits, 50, "marley");
    const [p] = aggregateEstimators(visits, 50, "pitmans");
    expect(all.visits).toBe(m.visits + p.visits);
    expect(all.fee).toBe(m.fee + p.fee);
    expect(all.won).toBe(m.won + p.won);
    expect(all.wonValue).toBe(m.wonValue + p.wonValue);
  });
});

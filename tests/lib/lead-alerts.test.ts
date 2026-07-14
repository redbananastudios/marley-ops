import { describe, expect, it } from "vitest";
import {
  ALERT_POLL_MS,
  CHIME_MAX_REPEATS,
  CHIME_REPEAT_MS,
  nextChimeState,
} from "@/lib/lead-alerts";

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";

describe("nextChimeState", () => {
  it("restarts on the first-ever unacked lead", () => {
    const d = nextChimeState(new Set(), [A]);
    expect(d.restart).toBe(true);
    expect([...d.chimed]).toEqual([A]);
  });

  it("does NOT restart when the same leads come back still unacked", () => {
    const d = nextChimeState(new Set([A, B]), [A, B]);
    expect(d.restart).toBe(false);
    expect(d.chimed).toEqual(new Set([A, B]));
  });

  it("restarts when a NEW lead id appears alongside old ones", () => {
    const d = nextChimeState(new Set([A]), [A, B]);
    expect(d.restart).toBe(true);
    expect(d.chimed).toEqual(new Set([A, B]));
  });

  it("goes quiet and forgets the batch when everything is acked", () => {
    const d = nextChimeState(new Set([A, B]), []);
    expect(d.restart).toBe(false);
    expect(d.chimed.size).toBe(0);
  });

  it("restarts for a genuinely new batch after the previous cleared", () => {
    // Previous batch acked -> empty set, then a fresh lead lands.
    const cleared = nextChimeState(new Set([A]), []).chimed;
    const d = nextChimeState(cleared, [C]);
    expect(d.restart).toBe(true);
    expect([...d.chimed]).toEqual([C]);
  });

  it("does not mutate the set passed in", () => {
    const prev = new Set([A]);
    nextChimeState(prev, [A, B]);
    expect(prev).toEqual(new Set([A]));
  });

  it("exposes sane chime-cycle constants", () => {
    expect(ALERT_POLL_MS).toBe(20_000);
    expect(CHIME_REPEAT_MS).toBe(3_000);
    expect(CHIME_MAX_REPEATS).toBe(10);
  });
});

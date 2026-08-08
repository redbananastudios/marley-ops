import { describe, it, expect } from "vitest";
import {
  surveyConfirmSubject,
  surveyConfirmEmailHtml,
  surveyConfirmEmailText,
  surveyRescheduleSubject,
  surveyRescheduleSms,
  surveyRescheduleEmailHtml,
  surveyRescheduleEmailText,
  surveyCancelledSubject,
  surveyCancelledSms,
  surveyCancelledEmailHtml,
  surveyCancelledEmailText,
  estimatorSurveySubject,
  estimatorSurveyEmailHtml,
  estimatorSurveyEmailText,
  type SurveyRescheduleInput,
  type EstimatorSurveyInput,
} from "@/lib/comms/survey-email";

const base: SurveyRescheduleInput = {
  customerName: "Alina Bradshaw",
  dateLabel: "Friday 14 August",
  timeLabel: "14:00",
  estimatorName: "Luke James",
  address: "12 Bimport, Shaftesbury, SP7",
  previousLabel: "Tuesday 11 August at 09:00",
};

/** House content rules: no em-dash in customer copy, UK English, no AI tells. */
function assertHouseStyle(text: string) {
  expect(text).not.toContain("—");
  expect(text).not.toMatch(/\bdelve\b|\bcrucial\b|\brobust\b/i);
}

describe("survey confirmation email", () => {
  it("names the slot in the subject", () => {
    expect(surveyConfirmSubject(base)).toBe("Your survey is booked: Friday 14 August, 14:00");
  });

  it("carries the estimator, address and duration into the body", () => {
    const html = surveyConfirmEmailHtml(base);
    expect(html).toContain("Luke James");
    expect(html).toContain("12 Bimport, Shaftesbury, SP7");
    expect(html).toContain("About 1 hour");
    assertHouseStyle(surveyConfirmEmailText(base));
  });

  it("falls back gracefully when nobody is named", () => {
    const anon = { ...base, customerName: null, estimatorName: null, address: null };
    expect(surveyConfirmEmailText(anon)).toContain("Hi there,");
    expect(surveyConfirmEmailHtml(anon)).toContain("One of our team");
  });
});

describe("survey reschedule email", () => {
  it("leads with the NEW time, not the old one", () => {
    expect(surveyRescheduleSubject(base)).toBe("Your survey has moved: Friday 14 August, 14:00");
    const sms = surveyRescheduleSms(base);
    expect(sms).toContain("moved to Friday 14 August at 14:00");
    assertHouseStyle(sms);
  });

  it("shows what the slot WAS so the customer can tell the two emails apart", () => {
    const html = surveyRescheduleEmailHtml(base);
    expect(html).toContain("Tuesday 11 August at 09:00");
    expect(html).toContain("line-through");
    expect(surveyRescheduleEmailText(base)).toContain("previously booked for Tuesday 11 August at 09:00");
  });

  it("omits the previous slot cleanly when it isn't known", () => {
    const noPrev = { ...base, previousLabel: null };
    expect(surveyRescheduleEmailHtml(noPrev)).not.toContain("line-through");
    const text = surveyRescheduleEmailText(noPrev);
    expect(text).not.toContain("previously");
    // No stray blank line where the omitted sentence was.
    expect(text).not.toContain("\n\n\n");
  });
});

describe("survey cancellation email", () => {
  it("tells the customer not to wait in", () => {
    expect(surveyCancelledSubject(base)).toBe("Your survey on Friday 14 August has been cancelled");
    expect(surveyCancelledSms(base)).toContain("don't wait in");
    expect(surveyCancelledEmailText(base)).toContain("Please don't wait in");
    assertHouseStyle(surveyCancelledEmailText(base));
  });

  it("offers a rebook rather than just closing the door", () => {
    const html = surveyCancelledEmailHtml(base);
    expect(html).toContain("01747 637070");
    expect(html.toLowerCase()).toContain("rebook");
  });
});

describe("estimator notice", () => {
  const est: EstimatorSurveyInput = {
    estimatorName: "Luke James",
    customerName: "Alina Bradshaw",
    dateLabel: "Friday 14 August",
    timeLabel: "14:00",
    address: "12 Bimport, Shaftesbury, SP7",
    customerPhone: "07700 900123",
    notes: "Park on the road, narrow drive",
    kind: "booked",
    previousLabel: null,
    leadUrl: "https://ops.marleymoves.co.uk/leads/abc",
  };

  it("carries the detail a push never can: address, phone and notes", () => {
    const html = estimatorSurveyEmailHtml(est);
    expect(html).toContain("07700 900123");
    expect(html).toContain("Park on the road, narrow drive");
    expect(html).toContain("https://ops.marleymoves.co.uk/leads/abc");
  });

  it("distinguishes reassigned from cancelled", () => {
    const removed = estimatorSurveyEmailText({ ...est, kind: "removed" });
    expect(removed).toContain("reassigned to someone else");
    const cancelled = estimatorSurveyEmailText({ ...est, kind: "cancelled" });
    // The critical difference: nobody is covering a cancelled visit.
    expect(cancelled).toContain("nobody else is going");
    expect(cancelled).not.toContain("reassigned");
    expect(estimatorSurveySubject({ ...est, kind: "cancelled" })).toContain("Survey cancelled");
    expect(estimatorSurveySubject({ ...est, kind: "removed" })).toContain("Survey reassigned");
  });

  it("says the customer was told separately, so the estimator doesn't double-message them", () => {
    expect(estimatorSurveyEmailText(est)).toContain("customer has had their own confirmation");
    expect(estimatorSurveyEmailHtml({ ...est, kind: "moved", previousLabel: "Tuesday 11 August at 09:00" })).toContain(
      "Tuesday 11 August at 09:00",
    );
  });

  it("escapes customer-supplied text rather than injecting it as markup", () => {
    const html = estimatorSurveyEmailHtml({ ...est, notes: '<script>alert("x")</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

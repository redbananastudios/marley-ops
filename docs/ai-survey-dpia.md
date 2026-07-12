# AI-assisted estimator video surveys: short DPIA

**Controller:** MarleyMoves Ltd  
**System owner:** Peter Farrell  
**Assessment date:** 12 July 2026  
**Scope:** estimator-only V1 in Marley Ops  
**Status:** approved for the internal and shadow rollout described in the AI survey PRD. Reassess after 30 shadow surveys, before customer self-capture, or after any material provider, retention, model or purpose change.

## Processing and purpose

An authenticated Marley estimator may record or import one room walkthrough at a time. Video and optional narration are used to propose a room-by-room moving inventory, catalogue volumes and vehicle guidance. The estimator must review every suggestion and confirm each room. AI output is never sent directly to a customer and never replaces the manual survey option.

The processing may contain the inside of a home, possessions, voices and incidental images of people, paperwork or screens. It is not intended to collect special-category data, identity documents, children or unrelated household activity. Estimators are instructed to avoid these wherever practical.

## Necessity, proportionality and lawful basis

The purpose is to produce a more complete and consistent inventory for an accurate removal quotation and safe vehicle planning. A room walkthrough is proportionate because the same information is already gathered during a manual in-home survey; AI assists the estimator with the item list rather than introducing a new customer-facing decision.

Marley's UK GDPR lawful basis is **legitimate interests**: preparing an accurate requested quote, planning the move and reducing avoidable operational errors. The interests are limited to the customer's requested removal service, the impact is reduced by estimator review, short retention and restricted access, and the customer can choose the normal manual survey instead. The recorded verbal or digital agreement is an additional transparency and choice control; it is not used to conceal or expand the stated purpose. Audio is optional and can be muted.

No solely automated decision with legal or similarly significant effect is made. The estimator remains responsible for the final inventory and quote.

## Data flow and recipients

1. The estimator records agreement in Marley Ops before capture.
2. Media uploads directly to the private `survey-media` object store through the media-store driver. Application metadata remains in Marley Ops PostgreSQL.
3. The job worker extracts a small set of frames and submits the minimum required media and prompt data to Google Gemini for inventory suggestions.
4. Suggestions, confidence, evidence timestamps and usage metadata return to Marley Ops for estimator review.
5. Confirmed items are copied into the existing cubic survey. Raw media and frames are deleted by the retention process unless a documented legal hold applies.

Recipients/processors are the Marley Ops hosting and storage providers and Google Gemini. Access is limited to authenticated office roles; the object bucket is private and signed access is short-lived. The application uses provider URLs and storage drivers from environment configuration, so a future move to Cloudflare R2 or a dedicated VPS does not require rewriting customer data.

Google may process data outside the UK. Marley's processor terms and applicable transfer safeguards must remain in force. Gemini input is used only for this service workflow and is not permitted to be used to train a public model under the selected service terms.

## Retention and rights

- Raw video, imported images and extracted frames: 30 days after the retention anchor, then automatic deletion.
- AI suggestions and confirmed inventory: retained with the quote/move record under Marley's normal business-record schedule.
- Abandoned or withdrawn pre-confirmation surveys: processing is cancelled and uploaded media is scheduled for deletion.
- Legal hold: only for a documented dispute or legal obligation, recorded in Marley Ops and reviewed manually.

Customers may request access, correction, deletion, restriction or objection through `hello@marleymoves.co.uk`. A withdrawal does not invalidate processing already lawfully completed, and statutory record-keeping may limit deletion of the final business record. The privacy policy explains the survey, provider processing, human review and media retention.

## Risks and controls

| Risk | Controls | Residual risk |
|---|---|---|
| Customer is filmed without informed choice | Four-part agreement screen, witnessed method and timestamp, manual alternative, capture blocked until complete | Low |
| Incidental people, paperwork or sensitive household details | Estimator guidance, room-only capture, slow targeted pan, optional/muted audio, short raw-media retention | Medium |
| Unauthorised access or disclosure | Office-only authentication, private bucket, row-level policies, service-role mutations, signed reads, no public customer link in V1 | Low |
| AI misses, duplicates or misclassifies an item | Confidence and evidence shown, deterministic reconciliation, every item and room requires human confirmation, manual editing remains available | Low |
| Excessive or indefinite retention | 30-day automated sweep, withdrawal/abandonment deletion, usage and retained-media metrics, legal hold is explicit | Low |
| Provider outage, cost overrun or lock-in | Per-survey/monthly caps, retry/dead-job controls, trigger-agnostic worker, portable PostgreSQL schema and media-store seam | Low |
| International transfer or provider term change | Processor terms and transfer safeguard review; reassess this DPIA before provider/model changes | Medium |
| Device upload fails and leaves partial data | Resumable TUS upload, visible progress/pause/retry, server validation and orphan/retention cleanup | Low |

## Approval, monitoring and review

Peter Farrell authorised the production deployment and estimator-only rollout on 12 July 2026. The feature can be stopped immediately with `ai_survey_enabled`; the existing manual survey remains available and confirmed inventory is not deleted by rollback.

For the first 30 field surveys Marley will run the PRD's shadow process: estimators keep the manual count, compare room coverage and volume, and report misses or duplicates. Review this DPIA and the rollout gates after those 30 surveys. Any customer self-capture link, real-time detection, new reuse of footage, longer retention, biometric use, special-category purpose, or provider change requires a fresh assessment before release.

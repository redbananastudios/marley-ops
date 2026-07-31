# Marley Ops - financial / count binding audit (2026-07-31)

Multi-agent sweep of 11 money/count surfaces (38 agents, audit -> adversarial verify). 21 confirmed mis-bindings. Plus the 2 already-known (schedule weekend capacity; bank-feed all-dates count) not re-listed here.

## HIGH (1)

### H1. dashboard-kpis - app/(dashboard)/page.tsx:188
**Shows:** Headline "Jobs won" KPI + its £ sub-value; "Profit this period" card (Booked revenue / Est. cost / Margin / Margin %); Lead→Job & Survey→Job conversion rings; Paid-performance "Won from ads" + ROAS; Estimator "£ Won" column

**Bug:** prog.won and prog.cost are built from quotes.filter(q => q.status === "accepted") with NO check on quotes.booking_cancelled_at or the lead's status. A cancelled booking leaves the quote at status='accepted' — markLeadLostAction (leads/actions.ts:481-627) only sets leads.status='declined' and stamps quotes.booking_cancelled_at, it never changes quote.status. So the cancelled job's agreed_price still lands in prog.won, and isWon(l)=prog.won.has(l.id) counts the declined lead in `jobs`. wonValue/wonCost/margin/paidWonValue and the estimator win all inherit it. /bookings (page.tsx:269) and lib/sales-report.ts both drop declined leads — the dashboard does not.

**Fails when:** Customer accepts a £2,400 quote this month, pays deposit, then cancels (lead→declined, refund queued). Dashboard still shows Jobs won +1, Booked revenue/Margin/ROAS include the £2,400, and the estimator is credited the win — numbers Peter reads as real bookings.

## MEDIUM (11)

### M1. bookings - app/(dashboard)/bookings/page.tsx:497
**Shows:** "Balance outstanding" headline £ stat (value=gbp(balanceOutstanding), sub "due in full before move day")

**Bug:** balanceOutstanding (lines 347-349) sums r.balanceAmount over every deposit-paid/balance-unpaid row, and balanceAmount (line 298) falls back to balanceDue(agreed, deposit) = gross - deposit whenever balance_invoice_amount is null. That fallback NEVER subtracts the 25% commitment, unlike the authoritative balance math computeBalanceCredits (accept-flow.ts:1727) which returns gross - deposit - commitmentCredit. commitment_invoice_amount IS fetched onto the row (line 285) but never applied to the balance. So for any booking on the Payments-Policy-v2 ladder whose commitment invoice is raised but whose balance invoice is not yet raised, the commitment amount is folded into 'Balance outstanding' — double-counting it against the '25% to collect' card (line 490) when unpaid, and counting already-banked money as outstanding when paid.

**Fails when:** Gross £2000, deposit £100 → commitment = 0.25*2000-100 = £400, true balance = £1500. Date confirmed so the £400 commitment invoice is raised and PAID; balance invoice not yet raised (balance_invoice_amount null). 'Balance outstanding' counts £1900 for this job instead of £1500, so the office sees £400 of money already in the bank reported as still owed. If the £400 is instead unpaid (commitment_due bucket), the same £400 shows in BOTH '25% to collect' and 'Balance outstanding'.

### M2. bookings - app/(dashboard)/bookings/page.tsx:646
**Shows:** Per-row balance figures: all_set row "{gbp(r.balanceAmount)} to invoice nearer the day" (line 646) and balance-overdue row "{gbp(r.balanceAmount)} unpaid" (line 466)

**Bug:** Same root as the stat: when balance_invoice_amount is null, r.balanceAmount = balanceDue(agreed, deposit) = gross - deposit, which omits the commitment credit that the real balance invoice will carve out. These rows only render this fallback figure BEFORE the balance invoice exists (once it exists, r.balanceInvoiceNumber is set and the correct balance_invoice_amount is shown at line 458). So the pre-invoice amount a human reads is inflated by the commitment (0.25*gross - deposit).

**Fails when:** Gross £2000, deposit £100, commitment £400 raised (paid or unpaid). An all_set row displays '£1900 to invoice nearer the day', but when the office clicks Invoice, createBalanceInvoiceFlow raises £1500 (computeBalanceCredits subtracts the £400 commitment). A balance-overdue row with no balance invoice yet shows '£1900 unpaid' and the office over-chases the customer for £400 that was already committed/collected.

### M3. dashboard-kpis - app/(dashboard)/page.tsx:279
**Shows:** "Balance due" needs-action card count (empty state "No balances outstanding")

**Bug:** Counts leads.filter(status==='confirmed' && !balance_paid_at) — i.e. every deposit-paid, not-yet-completed booking, including moves months out with no balance invoice raised and nothing actually collectable. /bookings classifies those as the 'all_set' bucket, kept distinct from 'balance_due'/'balance_overdue'. The card label "Balance due" implies money owed now, but the number is really "deposit paid, balance not yet settled".

**Fails when:** 10 confirmed bookings for moves 1-3 months out, none balance-invoiced yet → card reads "Balance due: 10" implying 10 customers owe their balance now; clicking through to /bookings shows them under "all set", with no balance-due rows.

### M4. performance-margin - lib/sales-report.ts:139
**Shows:** Sales tab "Revenue paid" KPI total + its "N payments" subtitle (money actually received in the period, deposits + balances).

**Bug:** The deposit loop iterates the raw `quotes` array (all statuses, no per-lead dedup) and counts `deposit_amount` for every row whose `deposit_paid_at` is in range. On the supported re-quote path, `supersedeSiblingQuotes` (lib/quote/accept-flow.ts L252-267) COPIES a paid deposit's `deposit_paid_at`/`deposit_amount` onto the new accepted quote but LEAVES the same stamps on the now-superseded old quote — so one real deposit exists as `deposit_paid_at` on two quote rows, and both are summed. (Note the day-scoped Payments view in lib/payments/received.ts explicitly dedupes deposits per lead-quote to avoid exactly this; buildSalesReport does not.)

**Fails when:** Customer pays a £100 deposit on quote A, then a survey re-quote supersedes A with accepted quote B (deposit carried over); if the deposit_paid_at falls in the selected range, "Revenue paid" reads £200 / "2 payments" for the single £100 actually received.

### M5. performance-margin - app/(dashboard)/performance/page.tsx:339
**Shows:** Overview "Jobs & margin": Revenue, Margin (revenue - totalCost) and Margin % per job + totals (marginPct colour-thresholded red/warn/green).

**Bug:** Revenue is the VAT-INCLUSIVE gross figure (`agreed_price ?? grand_total`; grand_total = total + 20% VAT per lib/quote/pricing.ts L221-222, and accept-flow confirms agreed_price is the gross "move price"), while the rate-card `totalCost` from jobCost carries no VAT component. Margin/Margin% therefore treat the entire VAT the customer paid as profit. Marley is on the VAT Flat Rate Scheme (settings.vatScheme=flat_rate, vatFlatRatePct 9-10%), so ~9-10% of the gross is owed to HMRC and is not margin — the calc mixes gross revenue with net cost.

**Fails when:** A £1,200 job (£1,000 + £200 VAT) with £600 rate-card cost shows Margin £600 / 50%; the ~£108 FRS VAT owed on the £1,200 gross is silently counted as profit, so the true margin (~£492 / ~41% of net) is overstated on the figure Peter uses to judge job profitability and pricing.

### M6. pipeline-counts - app/(dashboard)/board/page.tsx:69
**Shows:** Pipeline Board 'Mine' filter — the per-stage lead count badge and per-stage £ pipeline total shown in each column header (components/board/status-board.tsx line 423 count, line 427 gbp(total)).

**Bug:** BoardLead.estimator_id is bound to `surveyEstimator.get(l.id) ?? null` (survey-derived ownership ONLY). The page selects leads.estimator_id (line 21) but discards it and never calls ownerEstimatorId(). The /leads 'Mine' preset (leads/page.tsx line 134) uses the unified ownerEstimatorId(l.estimator_id, surveyEstimator) — explicit assignment OR survey. lib/leads/ownership.ts documents that this unification was added specifically so a lead 'can't appear in one place and vanish from the other'; the board was missed. The board's Mine filter (status-board.tsx line 185: `if (mine && l.estimator_id !== meId) return false`) therefore matches only survey-derived ownership.

**Fails when:** An estimator is manually assigned a lead before any survey is booked (leads.estimator_id = them, no survey appointment yet). On /leads under 'Mine' the lead appears; on the /board with 'Mine' on it disappears, and its value is dropped from the Mine-filtered column £ totals — so the estimator's owned pipeline count and £ value are understated and disagree between the two pipeline surfaces.

### M7. quotes - components/quotes/quotes-view.tsx:156
**Shows:** The "Win rate" summary stat (e.g. "67%") with sub-label "of sent quotes" (rendered at L193).

**Bug:** winRate = accepted.length / nonDraft.length, where nonDraft = quotes.filter(q => q.status !== "draft") (L150). That denominator counts `superseded` rows. A superseded quote is a RE-QUOTE of the same opportunity (accept-flow.ts L200-237 sets old sent quotes to `superseded` when a revised quote is accepted), so each re-quote adds a phantom loss to the denominator and understates the win rate. The canonical sales math (lib/sales-report.ts L98 and L127) explicitly excludes `superseded`/`draft` and dedups per lead; this dashboard stat does neither. The sub-label "of sent quotes" also misdescribes a denominator that actually spans accepted + sent + rejected + superseded.

**Fails when:** Lead A quoted £2000 (sent), re-quoted £2200 and accepted (v1 -> superseded); Lead B quoted once and accepted. Both opportunities won = 100%, but nonDraft = {superseded, accepted, accepted} = 3, accepted = 2, so the stat shows 67% "of sent quotes".

### M8. schedule-capacity - app/(dashboard)/schedule/page.tsx:216
**Shows:** Availability side panel: the "Thinking about it" badge "{softDemand.length} · £100 down" (schedule-allocation-view.tsx:868-870), the soft-demand list, and the "Provisional around this date / Ring to reserve" strip (view:812-829).

**Bug:** softDemand is built from accepted quotes with deposit_paid_at and no live removal (filter: q.lead_id && q.deposit_paid_at && !removalLeadIds.has(q.lead_id)), but it never reads quotes.booking_cancelled_at — that column is not even SELECTed in the quotes query (page.tsx:62-68). cancelBookingAction (app/actions/booking-change.ts:648-708) cancels the lead's removal appointment (status='cancelled', so it is excluded by the schedule page's .neq('status','cancelled') and drops out of removalLeadIds) while leaving the quote status='accepted' and deposit_paid_at set, only stamping booking_cancelled_at. So a cancelled+refunded lead satisfies the softDemand filter and re-enters the panel.

**Fails when:** Office cancels a booking (customer gets a full refund queued via refund_queue); that customer immediately reappears under "Thinking about it — £100 down" with a "Ring to reserve" prompt and increments the count, so staff ring a refunded customer to take a booking against a deposit that has already been given back.

### M9. schedule-capacity - app/(dashboard)/schedule/page.tsx:199
**Shows:** Availability calendar day grade (Available/Limited/Full/Over pill) and the day-summary "Vans free X / N" and "Crew free X / N" tiles (schedule-allocation-view.tsx:382 gradeOf→sumRequired; tiles 698-711).

**Bug:** A removal appointment whose lead has no accepted quote with a priceable breakdown — or a lead-less manual removal block — resolves required=null (page.tsx:163-168), and availAppts then coerces requiredVans/requiredCrew to 0 (page.tsx:199-200). sumRequired (lib/schedule/capacity.ts:76) therefore treats that booked move as needing 0 vans and 0 crew, so the day is graded on zero demand from it even though it is a real committed removal. The Job Board card (board/page.tsx:96) simply omits the vans/crew line for the same null, but the Availability grade makes a positive 'sellable' claim from the missing demand.

**Fails when:** Office books a removal onto the diary (or blocks the day) before the lead's quote is accepted; the Availability calendar still shows that day green "Available" with full "Crew free / Vans free", so a second move is sold onto an already-committed day.

### M10. storage-billing - lib/storage-report.ts:126
**Shows:** Performance → Storage revenue cards: 'Recurring / week', 'Recurring / month', 'Avg weekly rate', and 'Earned to date' (components/performance/storage-tab.tsx lines 131, 141, 146, 151).

**Bug:** weeklyRate() only special-cases 'month'; every other rate_period (including crate lets' 'day') falls through to `return r`, treating a per-DAY rate as a per-WEEK rate. Crate lets are stored with rate=crateDayInc (£3) and rate_period='day' (letDefaultsForUnitType), and buildStorageReport includes them in `open`/`lets` with no billing_model filter. So a £3/day crate is summed into perWeek as £3 (should be £21), perMonth is derived from that, avgWeeklyRate mixes £3 crate rates with true weekly-equivalents, and earnedToDate = letWeeks × £3 instead of days × £3 (~7x understatement). The cost report (buildStorageCostReport) handles crate_daily correctly via billing_model; the revenue report was never updated to match.

**Fails when:** One open crate let at £3/day stored 28 days: 'Recurring / week' shows £3 (real run-rate £21), 'Earned to date' shows ~£12 (real usage ~£84) — storage revenue understated ~7x per crate on the Performance tab.

### M11. storage-billing - components/performance/storage-tab.tsx:315
**Shows:** 'Who's in storage now' table, Rate column — a crate let renders e.g. '£3/wk'.

**Bug:** The rate label only distinguishes month vs everything-else: `l.rate_period === 'month' ? 'mo' : 'wk'`. A crate let has rate_period='day', so its per-DAY rate (£3) is labelled '/wk'. currentLets is built from letRows.filter(end_date==null) with no billing_model filter, so open crates appear here. (The Storage page UnitCard at storage-view.tsx:599 correctly handles 'day' → 'day'; this table does not.)

**Fails when:** A crate priced £3/day shows '£3/wk' in the current-lets table, so the reader believes the crate bills £3 per week when it actually bills £3 per day (~£21/week).

## LOW (9)

### L1. dashboard-kpis - components/dashboard/dashboard-view.tsx:132
**Shows:** "Median response" KPI tile, sitting in the Today / This week / This month period-toggled headline strip

**Bug:** Its value is data.medianRespMins, computed once over ALL leads (page.tsx:294-304) and never re-scoped by period. The other four tiles in the same strip (New leads, Contacted, Surveys booked, Jobs won) all recompute from s=data.periods[period]. Toggling the period changes every tile except this one, so an all-time figure is presented as if it belonged to the selected period.

**Fails when:** On a day where every enquiry was answered in minutes, selecting "Today" still shows the all-time median (e.g. "3h") beside today's fast counts, making today's response look slow.

### L2. finance-vat - app/(dashboard)/finance/page.tsx:252
**Shows:** The count badge on the "Invoices raised {day}" card header = dayInvoices.length

**Bug:** The header badge counts dayInvoices.length, which includes void AND draft invoices (the day-scoped listInvoices call at line 144 passes no status filter, so Zoho returns every status; InvoiceRow even renders draft/void pills). The adjacent "Invoiced" stat card sub-count for the SAME concept is daySummary.count (line 213, from summariseRaised at line 158) which EXCLUDES void+draft via isRaised(). So two figures on the same page both labelled "invoices raised {so far today}" disagree, and the badge over-counts because a draft was never raised and a void is no longer raised.

**Fails when:** An office admin starts one invoice in Zoho (draft) and voids another today, alongside 3 real ones: the "Invoiced" stat reads "3 invoices raised so far today" while the card header badge reads "5" for the identical "Invoices raised today" heading.

### L3. finance-vat - app/(dashboard)/finance/page.tsx:152
**Shows:** "VAT quarter to date" value = quarterVat.owed (line 231), plus the day/month VAT and invoiced totals

**Bug:** listInvoices returns a truncated flag when the 2,000-row (10x200) cap is hit, but only unpaidL.truncated is captured/surfaced (line 153 -> the Outstanding card warning at line 238). The dayL/mtdL/quarterL truncated flags are discarded, so a quarter window that exceeds 2,000 invoices silently drops the overflow and UNDERSTATES quarterSummary.gross and quarterVat.owed with no caveat, even though the help card (line 298) explicitly tells the reader "the quarter-to-date figure is the authoritative one."

**Fails when:** Once quarterly invoice volume passes 2,000 rows, the "authoritative" VAT-owed figure a human uses to gauge the HMRC liability quietly reports less VAT than is actually due, with the truncation flag already computed but thrown away.

### L4. performance-margin - app/(dashboard)/performance/page.tsx:340
**Shows:** Overview "Jobs & margin" table: Est. cost, Margin, Margin % per job and the Total row.

**Bug:** The `jobCost(...)` input object omits `transitVans` (available as `b.transitVans` on the stored breakdown, and `blob.transitVans` on the state blob), so jobCost defaults `transitVans` to 0. Each add-on Transit van should add 1 crew member (labour = crew x days x costLabourPerDay, ~£120/day) plus its share of fuel (miles x costFuelPerMile per vehicle) and the transit day rate. The revenue side (agreed_price/grand_total) DOES include the add-on Transit charge, so the cost is understated relative to the revenue it was priced against.

**Fails when:** A booked job priced with 1 add-on Transit van: agreed_price includes the transit charge + its man, but Est. cost is computed with transitVans=0, dropping ~£120/day of crew labour (plus transit fuel), so Margin and Margin % are overstated for that job and the Total.

### L5. pipeline-counts - app/(dashboard)/follow-ups/page.tsx:43
**Shows:** Follow-up card amount (£) for a 'Quote follow-up' reason — components/followups/followups-queue.tsx line 237 `gbp(r.amount)` (also used for the queue's value tie-break sort and passed into the prefilled chase template).

**Bug:** quoteOf binds the amount to the accepted quote if one exists, else to the FIRST row returned by an unordered `.in('lead_id', leadIds)` query with no status filter (lines 39-44). With no accepted quote it can therefore latch onto a superseded/rejected/older 'sent' quote rather than the current live quote; DB physical order is typically oldest-first, so it deterministically shows the stale value.

**Fails when:** A re-quoted lead has two 'sent' quotes — £500 then a revised £800, neither accepted. The Quote follow-up card shows £500 (oldest row) instead of the current £800, misstating the amount being chased and mis-ordering the queue by value.

### L6. quotes - components/quotes/quotes-view.tsx:75
**Shows:** The per-row FollowUp chip on sent quotes — "sent 8d ago · follow up" — and its escalation colour (grey <3d, amber >=3d, red >=7d).

**Bug:** Age is computed from `quote.updated_at || quote.created_at` and labelled "sent {ago} ago", but the quotes table has a BEFORE-UPDATE trigger (migration 0001 L181: trg_quotes_updated -> set_updated_at) that resets updated_at = now() on ANY row write. The real send timestamp is `email_sent_at` (the field sales-report.ts, accept-flow.ts and the chase cron all use), which isn't even fetched into QUOTE_COLUMNS. So any post-send write to the row resets the "sent ago" clock and the urgency tone.

**Fails when:** Office opens a sent-8-days-ago quote via ?edit=1 and tweaks a field (autosave -> saveQuoteDraft update) or reassigns its estimator (setQuoteEstimator update); updated_at jumps to now, so the row's chip flips from red "sent 8d ago · follow up" back to grey "sent 0m ago" and the genuinely-cold quote silently drops off the chase radar.

### L7. refunds-claims - app/(dashboard)/refunds/page.tsx:228
**Shows:** "To pay out" stat: value = gbpPence(view.totals.outstandingPence) with sub "across N entries" where N = view.totals.toExecuteCount

**Bug:** The money value (outstandingPence) sums ONLY refund-still-due across the To-execute section (queue-view.ts:520), but the paired count (toExecuteCount, queue-view.ts:518) counts EVERY To-execute entry — including entries that contribute £0 to the total: date-change rows where refundDuePence is forced to 0 (bookingStillLive, queue-view.ts:227), and rows already fully executed but not yet Completed (outstanding=0). So the count is scoped to a larger set than the money it summarises.

**Fails when:** One customer_cancel row owes £200 sits in To execute alongside 3 date-change rows (each £0 to pay out, just awaiting the 'Close' button): the card reads 'To pay out £200.00 across 4 entries', implying money is owed on 4 entries when only 1 needs paying.

### L8. refunds-claims - app/(dashboard)/refunds/execute-card.tsx:358
**Shows:** CompleteDialog body: "...confirming {gbpPence(item.refundDuePence)} has been returned across {N} payment(s)" where N = item.rails.filter(r => r.refundDuePence > 0).length

**Bug:** N counts RAILS with a refund due, but the copy labels it "payments". A single card rail can hold multiple card payments (each its own line), so a rail count understates the actual number of payment lines the email itemises (refundLinesFor iterates per-payment, actions/refunds.ts:199-210).

**Fails when:** A refund spanning 2 card payments (card rail) + 1 bank payment = 2 rails-with-due, so the confirm dialog says 'returned across 2 payments', while the itemised customer email lists 3 refund lines — the operator confirms a count that doesn't match what is sent.

### L9. refunds-claims - app/(dashboard)/claims/page.tsx:71
**Shows:** Open-tab badge "Open (openCount)" where openCount = all.filter(isOpenClaimStatus).length, computed over rows fetched with .limit(400) (line 65)

**Bug:** openCount (and the Open/All lists) are derived from at most the 400 most-recently-reported claims. Once total claims exceed 400, older still-open claims fall outside the fetch window entirely, so the badge under-counts open claims and those claims vanish from the list — a truncated-vs-live count rather than the true open total.

**Fails when:** With 401+ claims on file, a claim reported long ago and still 'assessing' is pushed out of the 400-row window: it is neither counted in 'Open (N)' nor shown in the Open tab, so a live liability silently disappears from the register. (Remote at a small removals firm's current volume, but a genuine scale ceiling.)

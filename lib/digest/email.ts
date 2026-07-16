/**
 * The weekly digest email — deliberately SHORT (Peter: "brief and short so
 * it's very easy for us to digest"). One compact table of this-week numbers
 * with last week alongside, a one-line highlight, a forward look, and only
 * the attention items that are non-zero. House style, no images beyond the
 * logo, renders in any client.
 */

import { gbp, trendArrow, type WeeklyDigest } from "@/lib/digest/weekly";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function digestSubject(d: WeeklyDigest): string {
  return `Marley week ${d.thisWeek.label}: ${gbp(d.thisWeek.moneyIn)} in · ${d.thisWeek.wins} won · ${d.thisWeek.jobsCompleted} jobs done`;
}

export function digestText(d: WeeklyDigest): string {
  const t = d.thisWeek;
  const l = d.lastWeek;
  const lines = [
    `Marley Moves — week ${t.label} (vs ${l.label})`,
    ``,
    `Money in: ${gbp(t.moneyIn)} (last week ${gbp(l.moneyIn)})`,
    `Enquiries: ${t.enquiries} (${l.enquiries}) · Quotes sent: ${t.quotesSent} worth ${gbp(t.quotesSentValue)} (${l.quotesSent})`,
    `Won: ${t.wins} worth ${gbp(t.winsValue)} (${l.wins}) · Lost: ${t.lost} (${l.lost})`,
    `Jobs completed: ${t.jobsCompleted} (${l.jobsCompleted}) · Surveys: ${t.surveysDone} (${l.surveysDone})`,
    d.biggestWin ? `Biggest win: ${d.biggestWin.firstName}'s move, ${gbp(d.biggestWin.value)} (${d.biggestWin.quoteRef})` : ``,
    `Coming up: ${d.nextWeekMoves} moves + ${d.nextWeekSurveys} surveys in the next 7 days`,
  ];
  const attention: string[] = [];
  if (t.exceptionsRecorded > 0) attention.push(`${t.exceptionsRecorded} job(s) signed off with exceptions`);
  if (d.snapshot.openClaims > 0) attention.push(`${d.snapshot.openClaims} open claim(s) on the Claims page`);
  if (d.snapshot.bankTransfersPending > 0) attention.push(`${d.snapshot.bankTransfersPending} bank transfer(s) need matching on Payments`);
  if (d.snapshot.openFollowUps > 0) attention.push(`${d.snapshot.openFollowUps} open follow-ups`);
  if (attention.length) lines.push(`Needs attention: ${attention.join(" · ")}`);
  return lines.filter(Boolean).join("\n");
}

export function buildDigestEmailHtml(d: WeeklyDigest): string {
  const t = d.thisWeek;
  const l = d.lastWeek;

  const row = (label: string, cur: string, prev: string, arrow: string) => `
    <tr>
      <td style="padding:7px 0;font-size:13px;color:#3a3a3a;border-bottom:1px solid #efece7;">${label}</td>
      <td align="right" style="padding:7px 0;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #efece7;white-space:nowrap;">${cur}</td>
      <td align="right" style="padding:7px 0 7px 14px;font-size:12px;color:#8a8a8a;border-bottom:1px solid #efece7;white-space:nowrap;">${prev}&nbsp;${arrow}</td>
    </tr>`;

  const attention: string[] = [];
  if (t.exceptionsRecorded > 0)
    attention.push(`<strong>${t.exceptionsRecorded}</strong> job${t.exceptionsRecorded === 1 ? "" : "s"} signed off with exceptions — check the sign-off records`);
  if (d.snapshot.openClaims > 0)
    attention.push(`<strong>${d.snapshot.openClaims}</strong> open claim${d.snapshot.openClaims === 1 ? "" : "s"} — <a href="https://ops.marleymoves.co.uk/claims" style="color:#c03838;">Claims</a>`);
  if (d.snapshot.bankTransfersPending > 0)
    attention.push(`<strong>${d.snapshot.bankTransfersPending}</strong> bank transfer${d.snapshot.bankTransfersPending === 1 ? "" : "s"} waiting to be matched on Payments`);
  if (d.snapshot.openFollowUps > 0)
    attention.push(`<strong>${d.snapshot.openFollowUps}</strong> open follow-up${d.snapshot.openFollowUps === 1 ? "" : "s"}`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f5f3;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(digestSubject(d))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #eae7e2;border-radius:8px;">
  <tr><td style="padding:22px 26px 0;">
    <img src="https://marleymoves.co.uk/logo.png" width="150" alt="Marley Moves" style="display:block;border:0;">
  </td></tr>
  <tr><td style="padding:14px 26px 0;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#c03838;font-weight:600;">Weekly digest</div>
    <div style="font-size:21px;font-weight:300;color:#111;padding-top:4px;">Week ${esc(t.label)}</div>
    <div style="font-size:12px;color:#8a8a8a;padding-top:2px;">compared with ${esc(l.label)}</div>
  </td></tr>
  <tr><td style="padding:14px 26px 0;font-family:'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="padding:0 0 4px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a8a8a;">&nbsp;</td>
        <td align="right" style="padding:0 0 4px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a8a8a;">This week</td>
        <td align="right" style="padding:0 0 4px 14px;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#8a8a8a;">Last week</td>
      </tr>
      ${row("Money in (deposits + balances)", gbp(t.moneyIn), gbp(l.moneyIn), trendArrow(t.moneyIn, l.moneyIn))}
      ${row("New enquiries", String(t.enquiries), String(l.enquiries), trendArrow(t.enquiries, l.enquiries))}
      ${row("Quotes sent", `${t.quotesSent} · ${gbp(t.quotesSentValue)}`, String(l.quotesSent), trendArrow(t.quotesSent, l.quotesSent))}
      ${row("Jobs won", `${t.wins} · ${gbp(t.winsValue)}`, String(l.wins), trendArrow(t.wins, l.wins))}
      ${row("Jobs lost", String(t.lost), String(l.lost), trendArrow(-t.lost, -l.lost))}
      ${row("Jobs completed", String(t.jobsCompleted), String(l.jobsCompleted), trendArrow(t.jobsCompleted, l.jobsCompleted))}
      ${row("Surveys done", String(t.surveysDone), String(l.surveysDone), trendArrow(t.surveysDone, l.surveysDone))}
    </table>
  </td></tr>
  ${
    d.biggestWin
      ? `<tr><td style="padding:14px 26px 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#3a3a3a;">
    Biggest win: <strong>${esc(d.biggestWin.firstName)}'s move</strong> at ${gbp(d.biggestWin.value)} (${esc(d.biggestWin.quoteRef)}).
  </td></tr>`
      : ""
  }
  <tr><td style="padding:12px 26px 0;font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#3a3a3a;">
    Coming up: <strong>${d.nextWeekMoves} move${d.nextWeekMoves === 1 ? "" : "s"}</strong> and <strong>${d.nextWeekSurveys} survey${d.nextWeekSurveys === 1 ? "" : "s"}</strong> booked over the next 7 days.
    ${d.snapshot.storageLetsOpen > 0 ? ` Storage: ${d.snapshot.storageLetsOpen} of ${d.snapshot.storageUnitsActive} units let.` : ""}
  </td></tr>
  ${
    attention.length
      ? `<tr><td style="padding:14px 26px 0;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="border-left:3px solid #c03838;background:#faf7f2;padding:10px 14px;font-size:13px;color:#3a3a3a;">
      ${attention.join("<br>")}
    </div>
  </td></tr>`
      : ""
  }
  <tr><td style="padding:16px 26px 22px;font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#8a8a8a;">
    Full detail any time: <a href="https://ops.marleymoves.co.uk/performance" style="color:#c03838;">Performance</a> ·
    <a href="https://ops.marleymoves.co.uk/finance" style="color:#c03838;">Invoices &amp; VAT</a> ·
    <a href="https://ops.marleymoves.co.uk/payments" style="color:#c03838;">Payments</a>
  </td></tr>
</table>
<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#a3a3a3;padding:12px;">Sent automatically by Marley Ops every Monday morning.</div>
</td></tr></table>
</body></html>`;
}

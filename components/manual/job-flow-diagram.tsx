/**
 * Full pipeline diagram — "how a job flows" from first enquiry to review
 * request. Inline SVG, no external images/deps. Two rows of charcoal boxes
 * joined by red arrows; row 1 wraps into row 2 via a single connector.
 */

type FlowNode = { lines: string[] };

const ROW1: FlowNode[] = [
  { lines: ["Website / phone", "enquiry"] },
  { lines: ["Lead created"] },
  { lines: ["Survey booked"] },
  { lines: ["Quote sent"] },
  { lines: ["Customer accepts", "the /q link"] },
  { lines: ["£100 deposit", "invoice raised"] },
];

const ROW2: FlowNode[] = [
  { lines: ["Deposit paid", "= Confirmed"] },
  { lines: ["Job Board:", "crew + van assigned"] },
  { lines: ["Balance invoice", "due 24h before"] },
  { lines: ["Move day: job sheet,", "sign-off, certificate"] },
  { lines: ["Review request"] },
];

const BOX_W = 176;
const BOX_H = 72;
const GAP_X = 16;
const MARGIN_X = 20;
const ROW1_Y = 24;
const ROW2_Y = 224;
const CONNECTOR_Y = 160;
const VIEW_W = MARGIN_X * 2 + ROW1.length * BOX_W + (ROW1.length - 1) * GAP_X;
const VIEW_H = ROW2_Y + BOX_H + 20;

const RED = "#c03838";
const CHARCOAL = "#22252b";

function xFor(i: number): number {
  return MARGIN_X + i * (BOX_W + GAP_X);
}

function FlowBox({ x, y, node }: { x: number; y: number; node: FlowNode }) {
  const cy = y + BOX_H / 2;
  const n = node.lines.length;
  const lineH = 15;
  const startY = cy - ((n - 1) * lineH) / 2 + 4;
  return (
    <g>
      <rect x={x} y={y} width={BOX_W} height={BOX_H} rx={10} fill={CHARCOAL} />
      {node.lines.map((line, i) => (
        <text
          key={i}
          x={x + BOX_W / 2}
          y={startY + i * lineH}
          textAnchor="middle"
          fontSize={i === 0 ? 13.5 : 12}
          fontWeight={i === 0 ? 600 : 400}
          fill={i === 0 ? "#ffffff" : "#c7c9ce"}
          fontFamily="var(--font-display, -apple-system, 'Segoe UI', Roboto, sans-serif)"
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function HArrow({ fromX, toX, y }: { fromX: number; toX: number; y: number }) {
  return <line x1={fromX} y1={y} x2={toX - 6} y2={y} stroke={RED} strokeWidth={2.5} markerEnd="url(#manual-arrow)" />;
}

export function JobFlowDiagram() {
  const row1CenterY = ROW1_Y + BOX_H / 2;
  const row2CenterY = ROW2_Y + BOX_H / 2;
  const lastRow1X = xFor(ROW1.length - 1);
  const firstRow2X = xFor(0);
  const connectorFromX = lastRow1X + BOX_W / 2;
  const connectorToX = firstRow2X + BOX_W / 2;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-4">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="mx-auto block w-full min-w-[760px] max-w-[1100px]"
        role="img"
        aria-label="Job pipeline: enquiry to lead, survey booked, quote sent, customer accepts and pays a deposit to confirm, then Job Board assigns crew and a van, a balance invoice is due 24 hours before the move, the crew complete the job sheet and sign-off on move day, and a review request follows."
      >
        <defs>
          <marker id="manual-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={RED} />
          </marker>
        </defs>

        {/* row 1 */}
        {ROW1.map((node, i) => (
          <FlowBox key={`r1-${i}`} x={xFor(i)} y={ROW1_Y} node={node} />
        ))}
        {ROW1.slice(0, -1).map((_, i) => (
          <HArrow key={`r1-arrow-${i}`} fromX={xFor(i) + BOX_W} toX={xFor(i + 1)} y={row1CenterY} />
        ))}

        {/* row 2 */}
        {ROW2.map((node, i) => (
          <FlowBox key={`r2-${i}`} x={xFor(i)} y={ROW2_Y} node={node} />
        ))}
        {ROW2.slice(0, -1).map((_, i) => (
          <HArrow key={`r2-arrow-${i}`} fromX={xFor(i) + BOX_W} toX={xFor(i + 1)} y={row2CenterY} />
        ))}

        {/* connector: end of row 1 down into start of row 2 */}
        <path
          d={`M ${connectorFromX} ${ROW1_Y + BOX_H} L ${connectorFromX} ${CONNECTOR_Y} L ${connectorToX} ${CONNECTOR_Y} L ${connectorToX} ${ROW2_Y - 6}`}
          fill="none"
          stroke={RED}
          strokeWidth={2.5}
          markerEnd="url(#manual-arrow)"
        />
      </svg>
      <p className="mt-3 text-center text-xs text-mist-400">
        Deposit paid is what moves a lead to <strong>Confirmed</strong> — nothing lands on the Job Board until then.
      </p>
    </div>
  );
}

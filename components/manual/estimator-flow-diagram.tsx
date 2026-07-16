/**
 * The estimator's loop — a single left-to-right row from fresh enquiry to
 * accepted quote. Same charcoal-box / red-arrow idiom as the office job-flow
 * diagram; the office takes over once the quote is accepted.
 */

type FlowNode = { lines: string[] };

const NODES: FlowNode[] = [
  { lines: ["New enquiry"] },
  { lines: ["Call them back", "(same day wins)"] },
  { lines: ["Survey", "(visit or AI scan)"] },
  { lines: ["Quote sent", "(chases run alone)"] },
  { lines: ["Accepted", "(office takes over)"] },
];

const BOX_W = 190;
const BOX_H = 78;
const GAP_X = 18;
const MARGIN_X = 20;
const ROW_Y = 20;
const VIEW_W = MARGIN_X * 2 + NODES.length * BOX_W + (NODES.length - 1) * GAP_X;
const VIEW_H = ROW_Y + BOX_H + 20;

const RED = "#c03838";
const CHARCOAL = "#22252b";

function xFor(i: number): number {
  return MARGIN_X + i * (BOX_W + GAP_X);
}

function FlowBox({ x, node }: { x: number; node: FlowNode }) {
  const cy = ROW_Y + BOX_H / 2;
  const n = node.lines.length;
  const lineH = 15;
  const startY = cy - ((n - 1) * lineH) / 2 + 4;
  return (
    <g>
      <rect x={x} y={ROW_Y} width={BOX_W} height={BOX_H} rx={10} fill={CHARCOAL} />
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

export function EstimatorFlowDiagram() {
  const centerY = ROW_Y + BOX_H / 2;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-4">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="mx-auto block w-full min-w-[640px] max-w-[980px]"
        role="img"
        aria-label="The estimator loop: a new enquiry, a same-day call back, the survey (a home visit or the AI room scan), the quote sent with automatic chases, and acceptance, at which point the office takes over."
      >
        <defs>
          <marker
            id="manual-arrow-estimator"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill={RED} />
          </marker>
        </defs>
        {NODES.map((node, i) => (
          <FlowBox key={i} x={xFor(i)} node={node} />
        ))}
        {NODES.slice(0, -1).map((_, i) => (
          <line
            key={i}
            x1={xFor(i) + BOX_W}
            y1={centerY}
            x2={xFor(i + 1) - 6}
            y2={centerY}
            stroke={RED}
            strokeWidth={2.5}
            markerEnd="url(#manual-arrow-estimator)"
          />
        ))}
      </svg>
    </div>
  );
}

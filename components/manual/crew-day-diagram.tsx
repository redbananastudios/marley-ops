/**
 * Small inline SVG for the crew's day — a single left-to-right row.
 * Same charcoal-box / red-arrow visual language as the full job-flow diagram.
 */

type FlowNode = { lines: string[] };

const NODES: FlowNode[] = [
  { lines: ["Log in", "→ /my-jobs"] },
  { lines: ["Today's jobs", "(day list)"] },
  { lines: ["Open a job:", "route, inventory,", "notes + photos"] },
  { lines: ["Sign off +", "completion", "certificate"] },
  { lines: ["Job sheet PDF", "any time"] },
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

export function CrewDayDiagram() {
  const centerY = ROW_Y + BOX_H / 2;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-4">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="mx-auto block w-full min-w-[640px] max-w-[980px]"
        role="img"
        aria-label="Crew day: log in to my-jobs, see today's job list, open a job to see the route, inventory and notes/photos, sign off with a completion certificate at the end, with the job sheet PDF available any time."
      >
        <defs>
          <marker id="manual-arrow-crew" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
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
            markerEnd="url(#manual-arrow-crew)"
          />
        ))}
      </svg>
    </div>
  );
}

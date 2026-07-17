/**
 * Stylised phone-screen illustrations for the role manuals. Drawn SVG, not
 * screenshots — screenshots rot with every release and leak test data, while
 * these live in code review like everything else. Idiom: a rounded-rect phone
 * frame, simplified grey UI blocks, and a red ring marking exactly where to
 * tap. Brand palette only (charcoal + mm-red), same as the flow diagrams.
 */

const RED = "#c03838";
const CHARCOAL = "#22252b";
const BLOCK = "#e9eaec";
const BLOCK_SOFT = "#f4f5f6";
const EDGE = "#d7d9dc";
const INK = "#4b5058";
const FONT = "var(--font-display, -apple-system, 'Segoe UI', Roboto, sans-serif)";

/** The shared frame: bezel, speaker, and the charcoal app bar. Children draw
 *  into the 20..200 × 70..415 content area. */
function PhoneSvg({ ariaLabel, children }: { ariaLabel: string; children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 220 430" role="img" aria-label={ariaLabel} className="h-auto w-full">
      <rect x={7} y={5} width={206} height={420} rx={30} fill="#ffffff" stroke={CHARCOAL} strokeWidth={6} />
      <rect x={88} y={17} width={44} height={6} rx={3} fill={CHARCOAL} opacity={0.22} />
      <rect x={20} y={32} width={180} height={28} rx={8} fill={CHARCOAL} />
      <text x={110} y={50} textAnchor="middle" fontSize={10} fontWeight={700} letterSpacing={1.5} fill="#ffffff" fontFamily={FONT}>
        MARLEY OPS
      </text>
      {children}
    </svg>
  );
}

/** The "tap here" marker — a double red ring around the target. */
function TapRing({ cx, cy, r = 22 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={RED} strokeWidth={3.5} />
      <circle cx={cx} cy={cy} r={r + 7} fill="none" stroke={RED} strokeWidth={1.5} opacity={0.4} />
    </g>
  );
}

/** Placeholder text rendered as soft grey bars. */
function TextLines({
  x,
  y,
  widths,
  gap = 9,
  h = 5,
  fill = "#c3c6cb",
}: {
  x: number;
  y: number;
  widths: number[];
  gap?: number;
  h?: number;
  fill?: string;
}) {
  return (
    <g>
      {widths.map((w, i) => (
        <rect key={i} x={x} y={y + i * gap} width={w} height={h} rx={2.5} fill={fill} />
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Crew manual illustrations — one per section, in day order.          */
/* ------------------------------------------------------------------ */

export function IlluDayList() {
  return (
    <PhoneSvg ariaLabel="Phone screen showing the My jobs list: the week strip at the top and a red ring around the first job card, meaning tap a job to open it">
      {Array.from({ length: 7 }).map((_, i) => (
        <g key={i}>
          <rect x={20 + i * 26} y={70} width={22} height={30} rx={6} fill={i === 0 ? RED : BLOCK_SOFT} stroke={i === 0 ? RED : EDGE} />
          <circle cx={31 + i * 26} cy={94} r={2.6} fill={i === 0 ? "#ffffff" : i === 2 ? RED : "#d0d3d7"} />
        </g>
      ))}
      <text x={20} y={122} fontSize={9.5} fontWeight={700} fill={INK} fontFamily={FONT}>
        TODAY
      </text>
      <rect x={20} y={130} width={180} height={66} rx={10} fill={BLOCK_SOFT} stroke={EDGE} />
      <rect x={20} y={130} width={4} height={66} rx={2} fill={RED} />
      <TextLines x={32} y={142} widths={[92, 70]} gap={12} h={6} fill="#b9bcc2" />
      <rect x={152} y={140} width={40} height={16} rx={8} fill={RED} />
      <text x={172} y={151} textAnchor="middle" fontSize={8} fontWeight={700} fill="#ffffff" fontFamily={FONT}>
        MOVE
      </text>
      <TextLines x={32} y={172} widths={[120]} h={5} />
      <TapRing cx={110} cy={163} r={26} />
      <rect x={20} y={206} width={180} height={66} rx={10} fill="#ffffff" stroke={EDGE} />
      <rect x={20} y={206} width={4} height={66} rx={2} fill="#7fb5ad" />
      <TextLines x={32} y={218} widths={[84, 64]} gap={12} h={6} fill="#cfd2d6" />
      <rect x={146} y={216} width={46} height={16} rx={8} fill={BLOCK} />
      <TextLines x={32} y={248} widths={[110]} h={5} fill="#dfe1e4" />
      <text x={20} y={296} fontSize={9.5} fontWeight={700} fill="#9aa0a8" fontFamily={FONT}>
        TOMORROW
      </text>
      <rect x={20} y={304} width={180} height={56} rx={10} fill="#ffffff" stroke={EDGE} />
      <TextLines x={32} y={316} widths={[96, 70]} gap={12} h={6} fill="#dfe1e4" />
    </PhoneSvg>
  );
}

export function IlluJobPage() {
  return (
    <PhoneSvg ariaLabel="Phone screen showing an open job: the customer name, the two address cards, the crew and vans, and the list of what you are moving">
      <TextLines x={20} y={72} widths={[104]} h={9} fill={CHARCOAL} />
      <TextLines x={20} y={88} widths={[70]} h={5} />
      {[0, 1].map((i) => (
        <g key={i}>
          <rect x={20 + i * 94} y={104} width={86} height={72} rx={9} fill={BLOCK_SOFT} stroke={EDGE} />
          <text x={28 + i * 94} y={119} fontSize={7.5} fontWeight={700} letterSpacing={0.6} fill={RED} fontFamily={FONT}>
            {i === 0 ? "FROM" : "TO"}
          </text>
          <TextLines x={28 + i * 94} y={126} widths={[58, 44]} gap={9} h={5} fill="#b9bcc2" />
          <rect x={28 + i * 94} y={150} width={56} height={16} rx={5} fill="#ffffff" stroke={EDGE} />
          <text x={56 + i * 94} y={161} textAnchor="middle" fontSize={7.5} fontWeight={600} fill={INK} fontFamily={FONT}>
            Directions
          </text>
        </g>
      ))}
      <rect x={20} y={186} width={86} height={44} rx={9} fill="#ffffff" stroke={EDGE} />
      <text x={28} y={201} fontSize={7.5} fontWeight={700} letterSpacing={0.6} fill="#9aa0a8" fontFamily={FONT}>
        CREW
      </text>
      <TextLines x={28} y={208} widths={[52, 40]} gap={9} h={5} />
      <rect x={114} y={186} width={86} height={44} rx={9} fill="#ffffff" stroke={EDGE} />
      <text x={122} y={201} fontSize={7.5} fontWeight={700} letterSpacing={0.6} fill="#9aa0a8" fontFamily={FONT}>
        VANS
      </text>
      <TextLines x={122} y={208} widths={[48]} gap={9} h={5} />
      <rect x={20} y={240} width={180} height={132} rx={10} fill="#ffffff" stroke={EDGE} />
      <text x={28} y={256} fontSize={7.5} fontWeight={700} letterSpacing={0.6} fill="#9aa0a8" fontFamily={FONT}>
        WHAT YOU ARE MOVING
      </text>
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x={28} y={266 + i * 22} width={i === 1 ? 96 : 116} height={5.5} rx={2.5} fill="#c3c6cb" />
          <circle cx={186} cy={269 + i * 22} r={6.5} fill={BLOCK} />
        </g>
      ))}
      <rect x={28} y={352} width={110} height={14} rx={7} fill="#fdf3e3" stroke="#e7c98d" />
      <text x={83} y={362} textAnchor="middle" fontSize={7} fontWeight={700} fill="#9a6b1f" fontFamily={FONT}>
        NOT MOVING · LEAVE IT
      </text>
    </PhoneSvg>
  );
}

export function IlluDirections() {
  return (
    <PhoneSvg ariaLabel="Phone screen with a red ring around the Directions button on an address card, and the map route it opens below">
      <rect x={20} y={70} width={180} height={92} rx={10} fill={BLOCK_SOFT} stroke={EDGE} />
      <text x={30} y={87} fontSize={8} fontWeight={700} letterSpacing={0.6} fill={RED} fontFamily={FONT}>
        MOVING TO
      </text>
      <TextLines x={30} y={96} widths={[120, 84]} gap={11} h={6} fill="#b9bcc2" />
      <rect x={30} y={126} width={92} height={24} rx={7} fill="#ffffff" stroke={CHARCOAL} />
      <text x={76} y={142} textAnchor="middle" fontSize={9} fontWeight={700} fill={CHARCOAL} fontFamily={FONT}>
        Directions
      </text>
      <TapRing cx={76} cy={138} r={24} />
      <rect x={20} y={182} width={180} height={196} rx={10} fill="#eef1ee" stroke={EDGE} />
      <path
        d="M 34 350 L 90 300 L 84 250 L 140 230 L 150 208"
        fill="none"
        stroke="#ffffff"
        strokeWidth={10}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 34 350 L 90 300 L 84 250 L 140 230 L 150 208"
        fill="none"
        stroke={RED}
        strokeWidth={3.5}
        strokeDasharray="7 5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={150} cy={202} r={9} fill={RED} />
      <circle cx={150} cy={202} r={3.4} fill="#ffffff" />
      <circle cx={34} cy={350} r={6} fill={CHARCOAL} />
    </PhoneSvg>
  );
}

export function IlluSignature() {
  return (
    <PhoneSvg ariaLabel="Phone screen with the yellow contract banner, a red ring around the Collect signature now button, and the box where the customer signs with a finger">
      <rect x={20} y={70} width={180} height={52} rx={9} fill="#fdf3e3" stroke="#e7c98d" />
      <path d="M 34 100 L 41 88 L 48 100 Z" fill="none" stroke="#9a6b1f" strokeWidth={2} strokeLinejoin="round" />
      <TextLines x={56} y={84} widths={[128, 96]} gap={11} h={5.5} fill="#dcc189" />
      <rect x={35} y={136} width={150} height={28} rx={8} fill={RED} />
      <text x={110} y={154} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#ffffff" fontFamily={FONT}>
        Collect signature now
      </text>
      <TapRing cx={110} cy={150} r={27} />
      <rect x={28} y={206} width={164} height={104} rx={10} fill="#ffffff" stroke="#c3c6cb" strokeDasharray="6 5" />
      <path
        d="M 48 276 C 66 240 76 240 84 264 C 90 282 100 250 116 252 C 132 254 132 272 152 254 C 160 246 168 250 174 256"
        fill="none"
        stroke={CHARCOAL}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <text x={110} y={334} textAnchor="middle" fontSize={9} fontWeight={600} fill={INK} fontFamily={FONT}>
        The customer signs with a finger
      </text>
    </PhoneSvg>
  );
}

export function IlluNotes() {
  return (
    <PhoneSvg ariaLabel="Phone screen showing the Crew notes and photos card: a box to type what is wrong, an Add photos button, and a red ring around the Save note button">
      <text x={20} y={84} fontSize={9} fontWeight={700} letterSpacing={0.8} fill="#9aa0a8" fontFamily={FONT}>
        CREW NOTES &amp; PHOTOS
      </text>
      <rect x={20} y={94} width={180} height={62} rx={10} fill="#ffffff" stroke={EDGE} />
      <TextLines x={32} y={108} widths={[152, 118, 88]} gap={12} h={5.5} fill="#d5d7da" />
      <rect x={20} y={166} width={42} height={42} rx={8} fill={BLOCK_SOFT} stroke={EDGE} />
      <rect x={68} y={166} width={42} height={42} rx={8} fill={BLOCK_SOFT} stroke={EDGE} />
      <rect x={20} y={226} width={94} height={30} rx={8} fill="#ffffff" stroke={CHARCOAL} />
      <rect x={33} y={235} width={16} height={12} rx={3} fill="none" stroke={INK} strokeWidth={1.8} />
      <circle cx={41} cy={241} r={3} fill="none" stroke={INK} strokeWidth={1.8} />
      <text x={80} y={245} textAnchor="middle" fontSize={8.5} fontWeight={600} fill={CHARCOAL} fontFamily={FONT}>
        Add photos
      </text>
      <rect x={122} y={226} width={78} height={30} rx={8} fill={RED} />
      <text x={161} y={245} textAnchor="middle" fontSize={9} fontWeight={700} fill="#ffffff" fontFamily={FONT}>
        Save note
      </text>
      <TapRing cx={161} cy={241} r={26} />
      <text x={110} y={300} textAnchor="middle" fontSize={9} fontWeight={600} fill={INK} fontFamily={FONT}>
        Only the office sees this
      </text>
    </PhoneSvg>
  );
}

export function IlluCapture() {
  return (
    <PhoneSvg ariaLabel="Phone screen with the Photo, Video and Voice buttons and a red ring around the round red camera button in the bottom corner">
      <rect x={20} y={70} width={180} height={130} rx={10} fill={BLOCK_SOFT} stroke={EDGE} />
      <TextLines x={32} y={84} widths={[120, 96, 108]} gap={14} h={6} fill="#d5d7da" />
      <rect x={30} y={222} width={160} height={26} rx={13} fill={BLOCK} />
      <rect x={33} y={225} width={50} height={20} rx={10} fill={RED} />
      <text x={58} y={239} textAnchor="middle" fontSize={8.5} fontWeight={700} fill="#ffffff" fontFamily={FONT}>
        Photo
      </text>
      <text x={110} y={239} textAnchor="middle" fontSize={8.5} fontWeight={600} fill={INK} fontFamily={FONT}>
        Video
      </text>
      <text x={162} y={239} textAnchor="middle" fontSize={8.5} fontWeight={600} fill={INK} fontFamily={FONT}>
        Voice
      </text>
      <text x={110} y={276} textAnchor="middle" fontSize={8.5} fontWeight={600} fill={INK} fontFamily={FONT}>
        Hold Voice and say what happened
      </text>
      <circle cx={168} cy={356} r={22} fill={RED} />
      <rect x={156} y={348} width={24} height={17} rx={4} fill="none" stroke="#ffffff" strokeWidth={2.2} />
      <circle cx={168} cy={356.5} r={4.4} fill="none" stroke="#ffffff" strokeWidth={2.2} />
      <TapRing cx={168} cy={356} r={29} />
    </PhoneSvg>
  );
}

export function IlluSignOff() {
  return (
    <PhoneSvg ariaLabel="Phone screen showing the end-of-job sign-off: the box for anything that went wrong, the two signature boxes for the customer and you, and the red Complete job button">
      <text x={20} y={82} fontSize={9} fontWeight={700} fill={INK} fontFamily={FONT}>
        Anything broken or gone wrong?
      </text>
      <rect x={20} y={90} width={180} height={52} rx={9} fill="#ffffff" stroke={EDGE} />
      <TextLines x={30} y={102} widths={[130, 96]} gap={12} h={5.5} fill="#d5d7da" />
      {[0, 1].map((i) => (
        <g key={i}>
          <text x={20 + i * 94} y={166} fontSize={8} fontWeight={700} letterSpacing={0.5} fill="#9aa0a8" fontFamily={FONT}>
            {i === 0 ? "CUSTOMER" : "YOU"}
          </text>
          <rect x={20 + i * 94} y={172} width={86} height={64} rx={9} fill="#ffffff" stroke="#c3c6cb" strokeDasharray="5 4" />
          <path
            d={
              i === 0
                ? "M 32 222 C 44 198 50 198 56 214 C 61 226 68 204 80 206 C 88 208 90 216 98 210"
                : "M 126 222 C 138 200 144 202 150 216 C 155 226 162 206 174 208 C 182 210 184 218 192 212"
            }
            fill="none"
            stroke={CHARCOAL}
            strokeWidth={2.2}
            strokeLinecap="round"
          />
        </g>
      ))}
      <rect x={30} y={262} width={160} height={30} rx={8} fill={RED} />
      <text x={110} y={281} textAnchor="middle" fontSize={10} fontWeight={700} fill="#ffffff" fontFamily={FONT}>
        Complete job
      </text>
      <TapRing cx={110} cy={277} r={28} />
      <text x={110} y={330} textAnchor="middle" fontSize={8.5} fontWeight={600} fill={INK} fontFamily={FONT}>
        The customer gets a certificate by email
      </text>
    </PhoneSvg>
  );
}

export function IlluJobSheet() {
  return (
    <PhoneSvg ariaLabel="Phone screen showing the one-page job sheet, a crossed-out pound sign meaning no prices on it, and a red ring around the Job sheet button">
      <rect x={48} y={72} width={124} height={168} rx={6} fill="#ffffff" stroke="#c3c6cb" />
      <rect x={48} y={72} width={124} height={18} rx={6} fill={CHARCOAL} />
      <text x={110} y={84} textAnchor="middle" fontSize={7.5} fontWeight={700} letterSpacing={1} fill="#ffffff" fontFamily={FONT}>
        JOB SHEET
      </text>
      <TextLines x={58} y={100} widths={[88, 72, 96, 60]} gap={12} h={5} fill="#c9ccd0" />
      <rect x={58} y={152} width={104} height={70} rx={4} fill={BLOCK_SOFT} stroke={EDGE} />
      <TextLines x={64} y={160} widths={[80, 68, 84, 56]} gap={15} h={4.5} fill="#b9bcc2" />
      <circle cx={110} cy={276} r={20} fill="#ffffff" stroke={RED} strokeWidth={3} />
      <text x={110} y={283} textAnchor="middle" fontSize={16} fontWeight={700} fill={CHARCOAL} fontFamily={FONT}>
        £
      </text>
      <line x1={96} y1={290} x2={124} y2={262} stroke={RED} strokeWidth={3.5} strokeLinecap="round" />
      <text x={110} y={310} textAnchor="middle" fontSize={9} fontWeight={700} fill={INK} fontFamily={FONT}>
        No prices on it. Ever.
      </text>
      <rect x={54} y={330} width={112} height={26} rx={8} fill="#ffffff" stroke={CHARCOAL} />
      <text x={110} y={347} textAnchor="middle" fontSize={9.5} fontWeight={700} fill={CHARCOAL} fontFamily={FONT}>
        Job sheet
      </text>
      <TapRing cx={110} cy={343} r={26} />
    </PhoneSvg>
  );
}

export function IlluDeviceSetup() {
  return (
    <PhoneSvg ariaLabel="Phone screen showing the Your device rows: job alerts switched on with a red ring around the toggle, face or fingerprint sign-in, and add to home screen">
      <text x={20} y={84} fontSize={9} fontWeight={700} letterSpacing={0.8} fill="#9aa0a8" fontFamily={FONT}>
        YOUR DEVICE
      </text>
      <rect x={20} y={94} width={180} height={52} rx={10} fill="#ffffff" stroke={EDGE} />
      <path
        d="M 38 124 C 38 112 42 108 47 108 C 52 108 56 112 56 124 L 59 128 L 35 128 Z"
        fill="none"
        stroke={INK}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <TextLines x={70} y={108} widths={[76, 56]} gap={11} h={5.5} />
      <rect x={152} y={110} width={36} height={20} rx={10} fill={RED} />
      <circle cx={178} cy={120} r={7.5} fill="#ffffff" />
      <TapRing cx={170} cy={120} r={26} />
      <rect x={20} y={156} width={180} height={52} rx={10} fill="#ffffff" stroke={EDGE} />
      <g fill="none" stroke={INK} strokeWidth={1.9} strokeLinecap="round">
        <path d="M 39 192 C 39 180 43 175 48 175 C 53 175 57 180 57 192" />
        <path d="M 44 193 C 44 184 45 181 48 181 C 51 181 52 184 52 193" />
        <path d="M 48 187 L 48 193" />
      </g>
      <TextLines x={70} y={170} widths={[88, 64]} gap={11} h={5.5} />
      <rect x={20} y={218} width={180} height={52} rx={10} fill="#ffffff" stroke={EDGE} />
      <rect x={34} y={230} width={26} height={26} rx={7} fill={RED} />
      <path
        d="M 40 245 L 47 238 L 54 245 M 43 245 L 43 250 L 51 250 L 51 245"
        fill="none"
        stroke="#ffffff"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <TextLines x={70} y={232} widths={[92, 58]} gap={11} h={5.5} />
      <text x={110} y={306} textAnchor="middle" fontSize={9} fontWeight={600} fill={INK} fontFamily={FONT}>
        Your phone buzzes when you get a job
      </text>
    </PhoneSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Estimator manual illustrations.                                     */
/* ------------------------------------------------------------------ */

export function IlluRoomScan() {
  return (
    <PhoneSvg ariaLabel="Phone screen filming a room for the AI room scan: a REC badge, a sofa in the viewfinder, a detected-item chip and the record button">
      <rect x={20} y={70} width={180} height={240} rx={10} fill="#26241f" />
      <circle cx={40} cy={90} r={5} fill={RED} />
      <text x={52} y={94} fontSize={9} fontWeight={700} letterSpacing={1} fill="#ffffff" fontFamily={FONT}>
        REC
      </text>
      <g fill="none" stroke="#ffffff" strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" opacity={0.9}>
        <path d="M 58 236 L 58 196 C 58 188 66 188 66 196 L 66 208 L 154 208 L 154 196 C 154 188 162 188 162 196 L 162 236 Z" />
        <path d="M 66 208 L 66 190 C 66 180 76 178 84 182 L 110 182 L 136 182 C 144 178 154 180 154 190" opacity={0.7} />
      </g>
      <rect x={70} y={248} width={80} height={16} rx={8} fill="#ffffff" opacity={0.92} />
      <text x={110} y={259} textAnchor="middle" fontSize={8} fontWeight={700} fill={CHARCOAL} fontFamily={FONT}>
        Sofa · 3 seats
      </text>
      <circle cx={110} cy={352} r={22} fill="none" stroke={CHARCOAL} strokeWidth={3} />
      <circle cx={110} cy={352} r={13} fill={RED} />
      <TapRing cx={110} cy={352} r={30} />
    </PhoneSvg>
  );
}

export function IlluWizardSteps() {
  return (
    <PhoneSvg ariaLabel="Phone screen showing the seven-step quote wizard: the progress dots with step three highlighted, form fields, and a red ring around the Next button">
      <text x={20} y={84} fontSize={10} fontWeight={700} fill={CHARCOAL} fontFamily={FONT}>
        New quote
      </text>
      <line x1={32} y1={106} x2={188} y2={106} stroke={EDGE} strokeWidth={3} />
      {Array.from({ length: 7 }).map((_, i) => (
        <circle
          key={i}
          cx={32 + i * 26}
          cy={106}
          r={i === 2 ? 8 : 6}
          fill={i < 2 ? CHARCOAL : i === 2 ? RED : "#ffffff"}
          stroke={i > 2 ? EDGE : "none"}
          strokeWidth={2}
        />
      ))}
      <text x={110} y={130} textAnchor="middle" fontSize={8.5} fontWeight={600} fill={INK} fontFamily={FONT}>
        Step 3 of 7 · Vehicle &amp; Packing
      </text>
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={20} y={146 + i * 56} width={60} height={6} rx={3} fill="#c3c6cb" />
          <rect x={20} y={158 + i * 56} width={180} height={30} rx={8} fill="#ffffff" stroke={EDGE} />
        </g>
      ))}
      <rect x={124} y={330} width={76} height={28} rx={8} fill={RED} />
      <text x={162} y={348} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#ffffff" fontFamily={FONT}>
        Next
      </text>
      <TapRing cx={162} cy={344} r={25} />
    </PhoneSvg>
  );
}

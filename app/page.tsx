// Game logic + UI wiring (client-side).
"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

const BOARD_SIZE = 6;
const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE;
/** Maximum number of cells the player may fire at before losing (if ships remain). */
const SHOT_LIMIT = 12;
/** After this many consecutive misses without a hit, show a subtle tip until the next hit. */
const CONSECUTIVE_MISS_HINT_AFTER = 3;
/** How long we keep the explosion icon visible before revealing the hit mark. */
const EXPLOSION_MS = 300;
/** Fade-out duration before applying a new game (also acts as a short intentional delay). */
const RESET_FADE_OUT_MS = 360;
const RESET_CONFIRM_MESSAGE =
  "Start a new game? Your current board and shots will be cleared.";

const STATS_STORAGE_KEY = "battleship-mini-stats-v1";

type PersistedStats = { wins: number; bestShots: number | null };

function readPersistedStats(): PersistedStats {
  if (typeof window === "undefined") return { wins: 0, bestShots: null };
  try {
    const raw = window.localStorage.getItem(STATS_STORAGE_KEY);
    if (!raw) return { wins: 0, bestShots: null };
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as PersistedStats).wins !== "number"
    ) {
      return { wins: 0, bestShots: null };
    }
    const wins = Math.max(0, Math.floor((parsed as PersistedStats).wins));
    const b = (parsed as PersistedStats).bestShots;
    const bestShots =
      typeof b === "number" && Number.isFinite(b)
        ? Math.max(1, Math.floor(b))
        : null;
    return { wins, bestShots };
  } catch {
    return { wins: 0, bestShots: null };
  }
}

function writePersistedStats(next: PersistedStats) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

const statsStoreListeners = new Set<() => void>();
let statsStoreVersion = 0;

/** Referentially stable while values match (for useSyncExternalStore). */
let cachedStatsSnapshot: PersistedStats = { wins: 0, bestShots: null };

function subscribeStatsStore(onStoreChange: () => void) {
  statsStoreListeners.add(onStoreChange);
  return () => statsStoreListeners.delete(onStoreChange);
}

function getStatsStoreSnapshot(): PersistedStats {
  void statsStoreVersion;
  const fresh = readPersistedStats();
  if (
    fresh.wins === cachedStatsSnapshot.wins &&
    fresh.bestShots === cachedStatsSnapshot.bestShots
  ) {
    return cachedStatsSnapshot;
  }
  cachedStatsSnapshot = { wins: fresh.wins, bestShots: fresh.bestShots };
  return cachedStatsSnapshot;
}

function emitStatsStoreChange() {
  statsStoreVersion += 1;
  statsStoreListeners.forEach((cb) => cb());
}

const SERVER_STATS_SNAPSHOT: PersistedStats = { wins: 0, bestShots: null };

/** Lengths of ships on the board. Each board cell may belong to at most one ship. */
const SHIP_LENGTHS = [3, 2] as const;
const EXPECTED_SHIP_CELL_COUNT = SHIP_LENGTHS.reduce((a, b) => a + b, 0);

/** Hard rule: no cell index may appear on more than one ship. */
function assertNoSharedShipCells(
  firstShip: readonly number[],
  secondShip: readonly number[],
): void {
  const occupiedByFirst = new Set(firstShip);
  for (const cell of secondShip) {
    if (occupiedByFirst.has(cell)) {
      throw new Error(
        `Invalid ship layout: cell ${cell} would be occupied by more than one ship.`,
      );
    }
  }
}

function assertEveryCellBelongsToAtMostOneShip(shipCells: Set<number>): void {
  if (shipCells.size !== EXPECTED_SHIP_CELL_COUNT) {
    throw new Error(
      `Invalid ship layout: need ${EXPECTED_SHIP_CELL_COUNT} distinct cells (no shared cells); got ${shipCells.size}.`,
    );
  }
}

function combineShipPlacements(ship3: number[], ship2: number[]): Set<number> {
  assertNoSharedShipCells(ship3, ship2);
  const cells = new Set([...ship3, ...ship2]);
  assertEveryCellBelongsToAtMostOneShip(cells);
  return cells;
}

type OutcomeTone = "ready" | "miss" | "hit" | "sunk" | "lost";

type Difficulty = "easy" | "medium" | "hard";

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

type GameState = {
  /** Bumps on each new deal; used to apply win stats exactly once per game. */
  dealId: number;
  difficulty: Difficulty;
  // All cells currently occupied by ships (length 3 and 2).
  shipCells: Set<number>;
  // Each individual ship as a list of its occupied cells.
  // Index 0 is the length-3 ship; index 1 is the length-2 ship.
  ships: number[][];
  // All cells the player has already clicked (hits + misses).
  shots: Set<number>;
  // Subset of `shipCells` that have been hit.
  hits: Set<number>;
  status: string;
  isWon: boolean;
  /** True when the player used all shots without sinking every ship. */
  isLost: boolean;
  /** Resets to 0 on any hit; used for optional miss-streak hints. */
  consecutiveMisses: number;
  // Used purely for UI feedback/animations.
  lastCell: number | null;
  lastOutcome: OutcomeTone;
};

const EXPLOSION_MAIN_DEGS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
const EXPLOSION_MID_DEGS = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5] as const;

function ExplosionIcon() {
  return (
    <svg
      width="46"
      height="46"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      focusable="false"
      className="overflow-visible"
    >
      {/* Shockwave rings */}
      <circle
        cx="32"
        cy="32"
        r="22"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.25"
      />
      <circle
        cx="32"
        cy="32"
        r="16"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.4"
      />
      {/* Secondary rays (between cardinals) */}
      <g stroke="currentColor" strokeLinecap="round" opacity="0.92">
        {EXPLOSION_MID_DEGS.map((deg) => (
          <line
            key={deg}
            x1="32"
            y1="32"
            x2="32"
            y2="14"
            strokeWidth="4"
            transform={`rotate(${deg} 32 32)`}
          />
        ))}
      </g>
      {/* Primary long rays */}
      <g stroke="currentColor" strokeLinecap="round">
        {EXPLOSION_MAIN_DEGS.map((deg) => (
          <line
            key={deg}
            x1="32"
            y1="32"
            x2="32"
            y2="8"
            strokeWidth="5.5"
            transform={`rotate(${deg} 32 32)`}
          />
        ))}
      </g>
      {/* Hot core */}
      <circle cx="32" cy="32" r="10" fill="currentColor" opacity="0.35" />
      <circle cx="32" cy="32" r="6" fill="currentColor" opacity="0.55" />
      <circle
        cx="32"
        cy="32"
        r="12"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.65"
      />
    </svg>
  );
}

function randPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cellRowCol(cell: number): { row: number; col: number } {
  return { row: Math.floor(cell / BOARD_SIZE), col: cell % BOARD_SIZE };
}

function minManhattanBetweenShips(a: readonly number[], b: readonly number[]): number {
  let min = Infinity;
  for (const ca of a) {
    const { row: ra, col: ca_ } = cellRowCol(ca);
    for (const cb of b) {
      const { row: rb, col: cb_ } = cellRowCol(cb);
      const d = Math.abs(ra - rb) + Math.abs(ca_ - cb_);
      if (d < min) min = d;
    }
  }
  return min;
}

function edgeCellCount(ship: readonly number[]): number {
  let n = 0;
  for (const c of ship) {
    const { row, col } = cellRowCol(c);
    if (row === 0 || row === BOARD_SIZE - 1 || col === 0 || col === BOARD_SIZE - 1) {
      n += 1;
    }
  }
  return n;
}

/** Cells that lie on a board corner (used to bias “along the rim” layouts). */
function cornerTouchCount(ship: readonly number[]): number {
  let n = 0;
  const last = BOARD_SIZE - 1;
  for (const c of ship) {
    const { row, col } = cellRowCol(c);
    if (
      (row === 0 || row === last) &&
      (col === 0 || col === last)
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * Each new deal picks a placement “doctrine” so layouts vary: sometimes tight groups,
 * sometimes rim-hugging, sometimes interior spread — not one static recipe per difficulty.
 */
type PlacementDoctrine =
  | "scatter"
  | "fleet_cluster"
  | "perimeter"
  | "open_water"
  | "tactical";

function rollPlacementDoctrine(difficulty: Difficulty): PlacementDoctrine {
  const r = Math.random();
  if (difficulty === "easy") {
    if (r < 0.26) return "scatter";
    if (r < 0.5) return "fleet_cluster";
    if (r < 0.74) return "perimeter";
    return "open_water";
  }
  if (difficulty === "medium") {
    if (r < 0.11) return "scatter";
    if (r < 0.34) return "fleet_cluster";
    if (r < 0.57) return "perimeter";
    if (r < 0.78) return "open_water";
    return "tactical";
  }
  if (r < 0.05) return "scatter";
  if (r < 0.23) return "fleet_cluster";
  if (r < 0.45) return "perimeter";
  if (r < 0.66) return "open_water";
  return "tactical";
}

function pairWeightForDoctrine(
  ships: number[][],
  doctrine: PlacementDoctrine,
): number {
  const s3 = ships[0]!;
  const s2 = ships[1]!;
  const d = minManhattanBetweenShips(s3, s2);
  const edges = edgeCellCount(s3) + edgeCellCount(s2);
  const corners = cornerTouchCount(s3) + cornerTouchCount(s2);
  const jitter = 0.58 + Math.random() * 0.9;

  switch (doctrine) {
    case "scatter":
      return jitter;
    case "fleet_cluster":
      return (1 / (0.22 + d * d)) * jitter;
    case "perimeter":
      return (1 + edges * 0.78 + corners * 0.52) * jitter;
    case "open_water":
      return (
        Math.exp(-edges * 0.4) * (1 + Math.min(d, 5) * 0.14) * jitter
      );
    case "tactical": {
      const mixed =
        isHorizontalShip(s3) !== isHorizontalShip(s2) ? 1.45 : 1;
      const spacing = Math.pow(Math.min(Math.max(d, 2), 6), 1.12);
      const edgeNudge = 1 + edges * 0.62;
      return edgeNudge * spacing * mixed * jitter;
    }
  }
}

function isHorizontalShip(ship: readonly number[]): boolean {
  if (ship.length < 2) return true;
  const sorted = [...ship].sort((x, y) => x - y);
  return sorted[1] - sorted[0] === 1;
}

function weightedPick<T>(items: T[], weight: (item: T) => number): T {
  const weights = items.map(weight);
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0 || !Number.isFinite(sum)) {
    return randPick(items);
  }
  let r = Math.random() * sum;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/** All valid non-overlapping (length-3, length-2) pairs on the 6×6 board. */
function getAllValidShipPairs(): { ships: number[][]; shipCells: Set<number> }[] {
  const pairs: { ships: number[][]; shipCells: Set<number> }[] = [];
  for (const ship3 of getPlacements(3)) {
    const occupied = new Set(ship3);
    for (const ship2 of getPlacements(2)) {
      if (!ship2.every((cell) => !occupied.has(cell))) continue;
      pairs.push({
        ships: [ship3, ship2],
        shipCells: combineShipPlacements(ship3, ship2),
      });
    }
  }
  return pairs;
}

let cachedValidShipPairs: { ships: number[][]; shipCells: Set<number> }[] | null = null;

function allValidShipPairs(): { ships: number[][]; shipCells: Set<number> }[] {
  if (!cachedValidShipPairs) {
    cachedValidShipPairs = getAllValidShipPairs();
  }
  return cachedValidShipPairs;
}

function generateShipsForDifficulty(
  difficulty: Difficulty,
): { ships: number[][]; shipCells: Set<number> } {
  const pairs = allValidShipPairs();
  const doctrine = rollPlacementDoctrine(difficulty);

  if (doctrine === "scatter") {
    return randPick(pairs);
  }

  return weightedPick(pairs, ({ ships }) =>
    pairWeightForDoctrine(ships, doctrine),
  );
}

function getPlacements(length: number): number[][] {
  const placements: number[][] = [];

  // Horizontal placements.
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col <= BOARD_SIZE - length; col++) {
      const cells: number[] = [];
      for (let i = 0; i < length; i++) {
        cells.push(row * BOARD_SIZE + (col + i));
      }
      placements.push(cells);
    }
  }

  // Vertical placements.
  for (let row = 0; row <= BOARD_SIZE - length; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const cells: number[] = [];
      for (let i = 0; i < length; i++) {
        cells.push((row + i) * BOARD_SIZE + col);
      }
      placements.push(cells);
    }
  }

  return placements;
}

let nextDealId = 1;

function createNewGame(difficulty: Difficulty): GameState {
  const { shipCells, ships } = generateShipsForDifficulty(difficulty);
  const dealId = nextDealId++;
  return {
    dealId,
    difficulty,
    shipCells,
    ships,
    shots: new Set<number>(),
    hits: new Set<number>(),
    status: "Take your shot",
    isWon: false,
    isLost: false,
    consecutiveMisses: 0,
    lastCell: null,
    lastOutcome: "ready",
  };
}

/** True when at least one ship has been hit but not yet fully sunk. */
function hasActiveHunt(game: GameState): boolean {
  return game.ships.some((ship) => {
    const onShip = ship.filter((c) => game.hits.has(c)).length;
    return onShip > 0 && onShip < ship.length;
  });
}

/** Short rule-based hint from the current board (reflects the latest move). */
function assistantTipForGame(game: GameState): string {
  if (game.isWon) {
    return "That was a strong finish — chase a lower shot count next time.";
  }
  if (game.isLost) {
    return "Every miss still narrows the grid. Reset and try a different pattern.";
  }
  if (game.shots.size === 0) {
    return "Fire when you're ready — I'll share a quick note after each shot.";
  }

  if (game.lastOutcome === "hit") {
    if (hasActiveHunt(game)) {
      return "You might want to search adjacent cells";
    }
    return "That was a strong guess";
  }

  if (game.lastOutcome === "miss") {
    if (hasActiveHunt(game)) {
      return "Try focusing on areas near previous hits";
    }
    if (game.consecutiveMisses >= CONSECUTIVE_MISS_HINT_AFTER) {
      return "You might want to search adjacent cells";
    }
    return "No contact — try another line or spacing.";
  }

  return "Keep going — you've got this.";
}

type ResetAnimPhase = "idle" | "fadeOut" | "fadeIn";

type HullFragment =
  | { kind: "h"; segment: "first" | "mid" | "last" | "single" }
  | { kind: "v"; segment: "first" | "mid" | "last" | "single" };

/** Geometric bow / mid / stern for each cell of a ship (independent of hit state). */
function hullFragmentsForShipCells(
  ship: readonly number[],
): Map<number, HullFragment> {
  const map = new Map<number, HullFragment>();
  const sorted = [...ship].sort((a, b) => a - b);
  if (sorted.length === 1) {
    map.set(sorted[0]!, { kind: "h", segment: "single" });
    return map;
  }
  const horizontal = sorted[1]! - sorted[0]! === 1;
  const kind = horizontal ? "h" : "v";
  sorted.forEach((cell, pos) => {
    const segment =
      pos === 0
        ? "first"
        : pos === sorted.length - 1
          ? "last"
          : "mid";
    map.set(cell, { kind, segment });
  });
  return map;
}

/** Metallic hull silhouette inside hit cells; segment matches orientation along the ship. */
function ShipHitHullGraphic({ fragment }: { fragment: HullFragment }) {
  const uid = useId().replace(/:/g, "");
  const gid = `hit-hull-${uid}`;

  let pathD: string;
  let deckLine: { x1: number; y1: number; x2: number; y2: number } | null =
    null;
  let turret: { cx: number; cy: number; r: number } | null = null;

  if (fragment.kind === "h") {
    if (fragment.segment === "single") {
      pathD =
        "M 12 50 L 22 24 L 78 24 L 88 50 L 78 76 L 22 76 Z";
      deckLine = { x1: 22, y1: 32, x2: 78, y2: 32 };
      turret = { cx: 50, cy: 50, r: 5 };
    } else if (fragment.segment === "first") {
      pathD = "M 2 50 L 12 20 L 100 20 L 100 80 L 12 80 Z";
      deckLine = { x1: 12, y1: 30, x2: 100, y2: 30 };
    } else if (fragment.segment === "mid") {
      pathD = "M 0 20 L 100 20 L 100 80 L 0 80 Z";
      deckLine = { x1: 0, y1: 30, x2: 100, y2: 30 };
      turret = { cx: 50, cy: 42, r: 6 };
    } else {
      pathD = "M 0 20 L 90 20 L 98 50 L 90 80 L 0 80 Z";
      deckLine = { x1: 0, y1: 30, x2: 90, y2: 30 };
    }
  } else if (fragment.segment === "single") {
    pathD =
      "M 50 12 L 76 22 L 76 78 L 50 88 L 24 78 L 24 22 Z";
    deckLine = { x1: 26, y1: 30, x2: 74, y2: 30 };
    turret = { cx: 50, cy: 52, r: 5 };
  } else if (fragment.segment === "first") {
    pathD = "M 50 2 L 80 12 L 80 100 L 20 100 L 20 12 Z";
    deckLine = { x1: 22, y1: 18, x2: 78, y2: 18 };
  } else if (fragment.segment === "mid") {
    pathD = "M 20 0 L 80 0 L 80 100 L 20 100 Z";
    deckLine = { x1: 22, y1: 28, x2: 78, y2: 28 };
    turret = { cx: 50, cy: 48, r: 6 };
  } else {
    pathD = "M 20 0 L 80 0 L 80 90 L 50 98 L 20 90 Z";
    deckLine = { x1: 22, y1: 22, x2: 78, y2: 22 };
  }

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-[9%] z-0 overflow-visible"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gid} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="rgb(148, 163, 184)" stopOpacity="0.55" />
          <stop offset="35%" stopColor="rgb(71, 85, 105)" stopOpacity="0.85" />
          <stop offset="100%" stopColor="rgb(30, 41, 59)" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id={`${gid}-rim`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(251, 113, 133, 0.45)" />
          <stop offset="100%" stopColor="rgba(244, 63, 94, 0.25)" />
        </linearGradient>
      </defs>
      <path
        d={pathD}
        fill={`url(#${gid})`}
        stroke={`url(#${gid}-rim)`}
        strokeWidth={2.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {deckLine && (
        <line
          x1={deckLine.x1}
          y1={deckLine.y1}
          x2={deckLine.x2}
          y2={deckLine.y2}
          stroke="rgba(255,255,255,0.22)"
          strokeWidth={1.2}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {turret && (
        <circle
          cx={turret.cx}
          cy={turret.cy}
          r={turret.r}
          fill="rgb(51, 65, 85)"
          stroke="rgba(255,255,255,0.2)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** Subtle per-cell hull strokes when that ship is fully hit (sunk); reads as one outline across the grid. */
function ShipOutlineWatermark({ fragment }: { fragment: HullFragment }) {
  const stroke =
    "pointer-events-none absolute z-[1] border-white/[0.2] shadow-none";
  if (fragment.kind === "h") {
    if (fragment.segment === "single") {
      return <span aria-hidden className={`${stroke} inset-[12%] rounded-lg border-[1.5px]`} />;
    }
    if (fragment.segment === "first") {
      return (
        <span
          aria-hidden
          className={`${stroke} inset-y-[10%] left-[10%] right-0 rounded-l-lg border-b-[1.5px] border-l-[1.5px] border-t-[1.5px] border-r-0`}
        />
      );
    }
    if (fragment.segment === "mid") {
      return (
        <span
          aria-hidden
          className={`${stroke} inset-y-[10%] left-0 right-0 border-b-[1.5px] border-t-[1.5px] border-l-0 border-r-0`}
        />
      );
    }
    return (
      <span
        aria-hidden
        className={`${stroke} inset-y-[10%] left-0 right-[10%] rounded-r-lg border-b-[1.5px] border-r-[1.5px] border-t-[1.5px] border-l-0`}
      />
    );
  }
  if (fragment.segment === "single") {
    return <span aria-hidden className={`${stroke} inset-[12%] rounded-lg border-[1.5px]`} />;
  }
  if (fragment.segment === "first") {
    return (
      <span
        aria-hidden
        className={`${stroke} inset-x-[10%] top-[10%] bottom-0 rounded-t-lg border-l-[1.5px] border-r-[1.5px] border-t-[1.5px] border-b-0`}
      />
    );
  }
  if (fragment.segment === "mid") {
    return (
      <span
        aria-hidden
        className={`${stroke} inset-x-[10%] top-0 bottom-0 border-b-0 border-l-[1.5px] border-r-[1.5px] border-t-0`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${stroke} inset-x-[10%] top-0 bottom-[10%] rounded-b-lg border-b-[1.5px] border-l-[1.5px] border-r-[1.5px] border-t-0`}
    />
  );
}

const WIN_STATS_SESSION_KEY = "battleship-win-stats-applied-id";
const WIN_FLAIR_SESSION_PREFIX = "battleship-win-flair:";

function readStoredWinFlair(
  fingerprint: string | null,
): { newBest: boolean } | null {
  if (!fingerprint || typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${WIN_FLAIR_SESSION_PREFIX}${fingerprint}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { newBest?: boolean }).newBest !== "boolean"
    ) {
      return null;
    }
    return { newBest: (parsed as { newBest: boolean }).newBest };
  } catch {
    return null;
  }
}

const DIFFICULTY_ORDER = ["easy", "medium", "hard"] as const satisfies readonly Difficulty[];

export default function Home() {
  const cells = useMemo(() => Array.from({ length: TOTAL_CELLS }, (_, i) => i), []);
  const [phase, setPhase] = useState<"setup" | "playing">("setup");
  const [pendingDifficulty, setPendingDifficulty] = useState<Difficulty>("medium");
  const [game, setGame] = useState<GameState | null>(null);
  const stats = useSyncExternalStore(
    subscribeStatsStore,
    getStatsStoreSnapshot,
    () => SERVER_STATS_SNAPSHOT,
  );
  const [explodingCells, setExplodingCells] = useState<Set<number>>(() => new Set());
  const explosionTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const boomShotKeysRef = useRef<Set<string>>(new Set());
  const [resetAnim, setResetAnim] = useState<ResetAnimPhase>("idle");
  const resetFadeOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!game?.isWon) return;
    const fingerprint = `${game.dealId}-${game.shots.size}`;
    if (typeof window !== "undefined") {
      try {
        if (sessionStorage.getItem(WIN_STATS_SESSION_KEY) === fingerprint) {
          return;
        }
        sessionStorage.setItem(WIN_STATS_SESSION_KEY, fingerprint);
      } catch {
        /* ignore */
      }
    }
    const prev = readPersistedStats();
    const shotsUsed = game.shots.size;
    const newBest = prev.bestShots === null || shotsUsed < prev.bestShots;
    const nextBest =
      prev.bestShots === null ? shotsUsed : Math.min(prev.bestShots, shotsUsed);
    const next: PersistedStats = {
      wins: prev.wins + 1,
      bestShots: nextBest,
    };
    writePersistedStats(next);
    try {
      if (typeof window !== "undefined") {
        sessionStorage.setItem(
          `${WIN_FLAIR_SESSION_PREFIX}${fingerprint}`,
          JSON.stringify({ newBest }),
        );
      }
    } catch {
      /* ignore */
    }
    emitStatsStoreChange();
  }, [game?.isWon, game?.shots.size, game?.dealId]);

  useEffect(() => {
    // These refs are mutated (we do not replace the underlying Map/Set),
    // so capturing the current object reference is safe for cleanup.
    const timers = explosionTimersRef.current;
    const boomShotKeys = boomShotKeysRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      boomShotKeys.clear();
      if (resetFadeOutTimerRef.current) {
        clearTimeout(resetFadeOutTimerRef.current);
        resetFadeOutTimerRef.current = null;
      }
    };
  }, []);

  // After swapping game state at opacity 0, run one frame at 0 then return to idle so opacity animates in.
  useEffect(() => {
    if (resetAnim !== "fadeIn") return;
    let cancelled = false;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!cancelled) setResetAnim("idle");
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [resetAnim]);

  const shipIndexByCell = useMemo(() => {
    const map = new Map<number, number>();
    if (!game) return map;
    game.ships.forEach((cellsOnShip, shipIdx) => {
      cellsOnShip.forEach((cell) => map.set(cell, shipIdx));
    });
    return map;
  }, [game]);

  const sunkHullFragmentByCell = useMemo(() => {
    const map = new Map<number, HullFragment>();
    if (!game) return map;
    for (const ship of game.ships) {
      if (!ship.every((c) => game.hits.has(c))) continue;
      hullFragmentsForShipCells(ship).forEach((frag, cell) => map.set(cell, frag));
    }
    return map;
  }, [game]);

  const hitHullFragmentByCell = useMemo(() => {
    const map = new Map<number, HullFragment>();
    if (!game) return map;
    for (const ship of game.ships) {
      hullFragmentsForShipCells(ship).forEach((frag, cell) => {
        if (game.hits.has(cell)) map.set(cell, frag);
      });
    }
    return map;
  }, [game]);

  const triggerExplosionForCell = (cellIndex: number) => {
    setExplodingCells((prev) => {
      const next = new Set(prev);
      next.add(cellIndex);
      return next;
    });

    const existing = explosionTimersRef.current.get(cellIndex);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      setExplodingCells((prev) => {
        if (!prev.has(cellIndex)) return prev;
        const next = new Set(prev);
        next.delete(cellIndex);
        return next;
      });
      explosionTimersRef.current.delete(cellIndex);
    }, EXPLOSION_MS);

    explosionTimersRef.current.set(cellIndex, timer);
  };

  const handleCellClick = (cellIndex: number) => {
    // Show explosion overlay immediately on the click that will be accepted (not inside `setGame`).
    if (resetAnim !== "idle") return;
    if (!game) return;
    if (game.isWon || game.isLost) return;
    if (game.shots.has(cellIndex)) return;

    const willBeHit = game.shipCells.has(cellIndex);
    if (willBeHit) {
      const boomKey = `${cellIndex}-${game.shots.size}`;
      if (!boomShotKeysRef.current.has(boomKey)) {
        boomShotKeysRef.current.add(boomKey);
        triggerExplosionForCell(cellIndex);
      }
    }

    setGame((prev) => {
      if (!prev) return prev;
      // Game is over; keep the end message visible and stop accepting shots.
      if (prev.isWon || prev.isLost) return prev;
      // Prevent clicking the same cell twice.
      if (prev.shots.has(cellIndex)) return prev;

      const shots = new Set(prev.shots);
      shots.add(cellIndex);

      const isHit = prev.shipCells.has(cellIndex);
      const hits = new Set(prev.hits);
      const lastCell = cellIndex;

      const outOfShots = (nextHits: Set<number>) =>
        shots.size >= SHOT_LIMIT && nextHits.size < prev.shipCells.size;

      const nextConsecutiveMisses = prev.consecutiveMisses + 1;

      if (!isHit) {
        if (outOfShots(hits)) {
          return {
            ...prev,
            shots,
            hits,
            status: "No shots left",
            isWon: false,
            isLost: true,
            consecutiveMisses: nextConsecutiveMisses,
            lastCell,
            lastOutcome: "lost",
          };
        }
        return {
          ...prev,
          shots,
          hits,
          status: "Miss!",
          isWon: false,
          consecutiveMisses: nextConsecutiveMisses,
          lastCell,
          lastOutcome: "miss",
        };
      }

      hits.add(cellIndex);
      const sunkAll = hits.size === prev.shipCells.size;
      if (sunkAll) {
        return {
          ...prev,
          shots,
          hits,
          status: `Cleared in ${shots.size} shot${shots.size === 1 ? "" : "s"}`,
          isWon: true,
          isLost: false,
          consecutiveMisses: 0,
          lastCell,
          lastOutcome: "sunk",
        };
      }
      if (outOfShots(hits)) {
        return {
          ...prev,
          shots,
          hits,
          status: "No shots left",
          isWon: false,
          isLost: true,
          consecutiveMisses: 0,
          lastCell,
          lastOutcome: "lost",
        };
      }
      return {
        ...prev,
        shots,
        hits,
        status: "Hit!",
        isWon: false,
        consecutiveMisses: 0,
        lastCell,
        lastOutcome: "hit",
      };
    });
  };

  const applyNewGameState = () => {
    explosionTimersRef.current.forEach((t) => clearTimeout(t));
    explosionTimersRef.current.clear();
    setExplodingCells(new Set());
    boomShotKeysRef.current.clear();
    const d = game?.difficulty ?? pendingDifficulty;
    setGame(createNewGame(d));
  };

  const startNewGameWithTransition = (requireConfirm: boolean) => {
    if (resetAnim !== "idle") return;
    if (!game) return;

    const hasProgress =
      game.shots.size > 0 || game.isWon || game.isLost;
    if (
      requireConfirm &&
      hasProgress &&
      typeof window !== "undefined"
    ) {
      if (!window.confirm(RESET_CONFIRM_MESSAGE)) return;
    }

    if (resetFadeOutTimerRef.current) {
      clearTimeout(resetFadeOutTimerRef.current);
      resetFadeOutTimerRef.current = null;
    }

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || !hasProgress) {
      applyNewGameState();
      return;
    }

    setResetAnim("fadeOut");
    resetFadeOutTimerRef.current = setTimeout(() => {
      resetFadeOutTimerRef.current = null;
      applyNewGameState();
      setResetAnim("fadeIn");
    }, RESET_FADE_OUT_MS);
  };

  const handleReset = () => startNewGameWithTransition(true);

  const handlePlayAgain = () => startNewGameWithTransition(false);

  const handleStartFromSetup = () => {
    setGame(createNewGame(pendingDifficulty));
    setPhase("playing");
  };

  const canRedealSamePhase =
    game !== null &&
    game.shots.size === 0 &&
    !game.isWon &&
    !game.isLost;

  const applyDifficultyBeforeFirstShot = (d: Difficulty) => {
    setPendingDifficulty(d);
    if (canRedealSamePhase) {
      setGame(createNewGame(d));
    }
  };

  const handleBackToDifficulty = () => {
    if (!game) {
      setPhase("setup");
      return;
    }
    const hasProgress =
      game.shots.size > 0 || game.isWon || game.isLost;
    if (
      hasProgress &&
      typeof window !== "undefined" &&
      !window.confirm(
        "Return to difficulty selection? Your current game will be discarded.",
      )
    ) {
      return;
    }
    explosionTimersRef.current.forEach((t) => clearTimeout(t));
    explosionTimersRef.current.clear();
    setExplodingCells(new Set());
    boomShotKeysRef.current.clear();
    setResetAnim("idle");
    if (resetFadeOutTimerRef.current) {
      clearTimeout(resetFadeOutTimerRef.current);
      resetFadeOutTimerRef.current = null;
    }
    setPendingDifficulty(game.difficulty);
    setGame(null);
    setPhase("setup");
  };

  const playing = phase === "playing" && game !== null;

  const statusDotTone =
    !game
      ? "bg-teal-400 shadow-[0_0_18px_rgba(45,212,191,0.55)]"
      : game.lastOutcome === "miss"
      ? "bg-slate-400 shadow-[0_0_14px_rgba(148,163,184,0.45)]"
      : game.lastOutcome === "hit"
        ? "bg-rose-400 shadow-[0_0_20px_rgba(251,113,133,0.75)]"
        : game.lastOutcome === "sunk"
          ? "bg-amber-400 shadow-[0_0_22px_rgba(251,191,36,0.65)]"
          : game.lastOutcome === "lost"
            ? "bg-red-500/90 shadow-[0_0_18px_rgba(239,68,68,0.5)]"
            : "bg-teal-400 shadow-[0_0_18px_rgba(45,212,191,0.55)]";

  const statusTextTone =
    !game
      ? "text-white"
      : game.lastOutcome === "miss"
      ? "text-slate-200"
      : game.lastOutcome === "hit"
        ? "text-rose-50"
        : game.lastOutcome === "sunk"
          ? "text-amber-50"
          : game.lastOutcome === "lost"
            ? "text-red-100"
            : "text-white";

  const shotsRemaining = game
    ? Math.max(0, SHOT_LIMIT - game.shots.size)
    : SHOT_LIMIT;
  const gameEnded = game ? game.isWon || game.isLost : false;
  const winFingerprint =
    game?.isWon ? `${game.dealId}-${game.shots.size}` : null;
  const storedWinFlair = readStoredWinFlair(winFingerprint);
  const beatPersonalBest =
    !!game &&
    game.isWon &&
    (storedWinFlair?.newBest === true ||
      (storedWinFlair === null &&
        (stats.bestShots === null || game.shots.size < stats.bestShots)));
  const wonAboveBestRecord =
    !!game &&
    game.isWon &&
    stats.bestShots !== null &&
    game.shots.size > stats.bestShots;
  const showShipAdjacencyHint =
    !!game &&
    !gameEnded &&
    game.consecutiveMisses >= CONSECUTIVE_MISS_HINT_AFTER &&
    resetAnim === "idle";
  const isResetting = resetAnim !== "idle";

  return (
    <div className="relative min-h-screen overflow-x-hidden text-white flex flex-col items-center px-4 py-10 sm:py-12 bg-gradient-to-b from-[#070b14] via-[#0c1526] to-[#0a1220]">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(45,212,191,0.12),transparent_55%)]"
        aria-hidden
      />
      <header className="relative w-full max-w-xl text-center">
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-teal-200 via-white to-cyan-200 bg-clip-text text-transparent drop-shadow-[0_2px_24px_rgba(45,212,191,0.25)]">
          Battleship
        </h1>
        <p className="mt-2 text-slate-400/95 text-sm sm:text-base">
          Find and sink all hidden ships
        </p>
        {stats.wins > 0 && (
          <p className="mt-3 text-xs sm:text-sm text-slate-500/90 tabular-nums tracking-wide">
            Wins {stats.wins}
            {stats.bestShots !== null && (
              <>
                {" "}
                · Best {stats.bestShots} shot{stats.bestShots === 1 ? "" : "s"}
              </>
            )}
          </p>
        )}
        {playing && game && (
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.18em] text-teal-300/85">
            Difficulty · {DIFFICULTY_LABELS[game.difficulty]}
          </p>
        )}
      </header>

      <section className="relative w-full max-w-xl flex flex-col items-center mt-10">
        <div
          className={[
            "w-full flex flex-col items-center transition-[opacity,transform,filter] duration-300 ease-out",
            resetAnim === "fadeOut"
              ? "pointer-events-none opacity-0 scale-[0.97] blur-[1.5px]"
              : resetAnim === "fadeIn"
                ? "pointer-events-none opacity-0 scale-[0.99]"
                : "opacity-100 scale-100 blur-0",
          ].join(" ")}
        >
        {!playing && (
          <div className="w-full max-w-lg rounded-2xl border border-white/12 bg-white/[0.06] backdrop-blur-sm px-5 py-8 sm:px-8 sm:py-10 shadow-[0_8px_40px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]">
            <h2 className="text-center text-lg font-bold tracking-tight text-white">
              Choose difficulty
            </h2>
            <p className="mt-2 text-center text-sm text-slate-400/95 leading-relaxed">
              Ship layouts vary each new game—clusters, edges, open water, or
              mixed tactics—weighted by level. Pick one, then
              start the game.
            </p>
            <div
              className="mt-6 flex flex-col gap-3"
              role="radiogroup"
              aria-label="Difficulty"
            >
              {DIFFICULTY_ORDER.map((d) => {
                const selected = pendingDifficulty === d;
                const blurb =
                  d === "easy"
                    ? "Ships placed randomly across the grid."
                    : d === "medium"
                      ? "Ships tend to sit closer together."
                      : "Edges, spacing, and mixed layouts — harder to guess.";
                return (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setPendingDifficulty(d)}
                    className={[
                      "w-full rounded-xl border px-4 py-3.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60",
                      selected
                        ? "border-teal-400/45 bg-teal-500/20 shadow-[0_0_28px_rgba(45,212,191,0.12)]"
                        : "border-white/10 bg-white/[0.04] hover:border-white/18 hover:bg-white/[0.07]",
                    ].join(" ")}
                  >
                    <div className="text-sm font-semibold text-teal-100/95">
                      {DIFFICULTY_LABELS[d]}
                    </div>
                    <div className="mt-1 text-xs text-slate-400/90 leading-snug">
                      {blurb}
                    </div>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={handleStartFromSetup}
              className="mt-8 w-full rounded-xl border border-teal-400/35 bg-teal-500/20 px-6 py-3.5 text-sm font-semibold text-teal-50 transition-[background-color,border-color,box-shadow,transform] duration-200 ease-out hover:bg-teal-500/30 hover:border-teal-300/45 hover:shadow-[0_0_28px_rgba(45,212,191,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60 active:scale-[0.99]"
            >
              Start game
            </button>
          </div>
        )}
        {playing && game && (
          <>
        {game.isWon && (
          <div className="w-full mb-5 rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/15 to-orange-600/10 px-5 py-4 shadow-[0_0_48px_rgba(251,191,36,0.15)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold tracking-wide text-amber-100">
                  You win!
                </div>
                <div className="mt-1 text-sm text-slate-300">
                  {beatPersonalBest ? (
                    <span className="text-amber-100/95">
                      New personal best — see if you can go lower.
                    </span>
                  ) : wonAboveBestRecord ? (
                    <>
                      Your best is {stats.bestShots} shot
                      {stats.bestShots === 1 ? "" : "s"}. Try again?
                    </>
                  ) : (
                    <>
                      All ships sunk. Reset for a fresh grid — chase a lower
                      shot count.
                    </>
                  )}
                </div>
              </div>
              <div className="text-xs font-medium text-amber-200/90 tabular-nums shrink-0 text-right leading-snug">
                <div>
                  Used {game.shots.size}/{SHOT_LIMIT}
                </div>
                <div className="text-amber-200/60">shots</div>
              </div>
            </div>
          </div>
        )}
        {game.isLost && (
          <div className="w-full mb-5 rounded-2xl border border-red-500/35 bg-gradient-to-br from-red-950/40 to-slate-950/50 px-5 py-4 shadow-[0_0_48px_rgba(239,68,68,0.12)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold tracking-wide text-red-200">
                  Game Over
                </div>
                <div className="mt-1 text-sm text-slate-400">
                  Out of shots with ships still afloat. Press Reset to try again.
                </div>
              </div>
              <div className="text-xs font-medium text-red-200/80 tabular-nums">
                Shots left: {shotsRemaining}/{SHOT_LIMIT}
              </div>
            </div>
          </div>
        )}
        <div
          className="w-full rounded-2xl border border-white/12 bg-white/[0.06] backdrop-blur-sm px-5 py-5 sm:px-6 sm:py-6 shadow-[0_8px_40px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex items-center justify-center gap-3 sm:justify-start min-h-[2.75rem] sm:min-h-0">
              <span
                className={[
                  "inline-block h-3.5 w-3.5 shrink-0 rounded-full transition-all duration-500 ease-out",
                  statusDotTone,
                ].join(" ")}
              />
              <p
                className={[
                  "text-xl sm:text-2xl font-bold tracking-tight leading-snug text-center sm:text-left drop-shadow-[0_2px_12px_rgba(0,0,0,0.35)]",
                  statusTextTone,
                ].join(" ")}
              >
                {game.status}
              </p>
            </div>
            <div className="flex flex-col items-center gap-1 sm:items-end">
              <span className="text-center sm:text-right text-xs font-semibold uppercase tracking-wider text-slate-500 tabular-nums">
                6×6
              </span>
              <span className="text-center sm:text-right text-xs font-semibold tabular-nums text-teal-200/90">
                Shots left: {shotsRemaining}/{SHOT_LIMIT}
              </span>
            </div>
          </div>
          {canRedealSamePhase && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 border-t border-white/[0.08] pt-4">
              <span className="w-full text-center text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:w-auto sm:text-left">
                New fleet (no shots yet)
              </span>
              <div
                className="flex flex-wrap justify-center gap-1.5"
                role="group"
                aria-label="Redeal difficulty"
              >
                {DIFFICULTY_ORDER.map((d) => {
                  const active = game.difficulty === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => applyDifficultyBeforeFirstShot(d)}
                      className={[
                        "rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition-[background-color,border-color,color] duration-150",
                        active
                          ? "border-teal-400/50 bg-teal-500/25 text-teal-50"
                          : "border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-300",
                      ].join(" ")}
                    >
                      {DIFFICULTY_LABELS[d]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {showShipAdjacencyHint && (
            <p
              className="mt-3 text-center text-[11px] sm:text-xs text-slate-500/65 leading-snug tracking-wide motion-safe:animate-[hint-fade_0.5s_ease-out_forwards]"
              aria-live="polite"
            >
              Tip: Ships occupy adjacent cells
            </p>
          )}
        </div>

        <div
          className="mt-4 w-full rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/[0.07] to-teal-600/[0.04] px-4 py-3.5 sm:px-5 sm:py-4 shadow-[0_6px_32px_rgba(34,211,238,0.08),inset_0_1px_0_rgba(255,255,255,0.05)]"
          aria-label="Assistant"
        >
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-200/80">
            Assistant
          </div>
          <p
            className="mt-1.5 text-sm leading-snug text-slate-200/95"
            aria-live="polite"
          >
            {assistantTipForGame(game)}
          </p>
        </div>

        <div className="mt-7 w-full flex flex-col items-center gap-2.5">
          <div className="w-full text-center text-xs font-semibold tracking-[0.2em] uppercase text-slate-500">
            Target grid
          </div>
          <div
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-slate-400"
            aria-label={`Legend: hit and miss colors${game.isLost ? ", ship revealed" : ""}`}
          >
            <span className="inline-flex items-center gap-2">
              <span
                className="h-4 w-4 shrink-0 rounded border border-rose-300/75 bg-gradient-to-br from-rose-500/50 via-rose-600/40 to-orange-700/35 shadow-[0_0_12px_rgba(244,63,94,0.35)]"
                aria-hidden
              />
              <span>Hit</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <span
                className="h-4 w-4 shrink-0 rounded border border-slate-500/40 bg-slate-800/45"
                aria-hidden
              />
              <span>Miss</span>
            </span>
            {game.isLost && (
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-4 w-4 shrink-0 rounded border border-teal-300/25 bg-teal-400/10 shadow-[0_0_12px_rgba(45,212,191,0.18)]"
                  aria-hidden
                />
                <span>Ship (revealed)</span>
              </span>
            )}
          </div>
          <div
            className="mx-auto w-full max-w-[min(92vw,420px)] rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
            aria-hidden
          >
            <div
              role="grid"
              aria-label="Battleship 6 by 6 grid"
              aria-disabled={gameEnded || isResetting}
              className={[
                "mx-auto grid w-full max-w-[min(100%,360px)] grid-cols-6 gap-2 sm:gap-2",
                gameEnded || isResetting ? "pointer-events-none" : "",
              ].join(" ")}
            >
              {cells.map((i) => {
                const isHit = game.hits.has(i);
                const isShot = game.shots.has(i);
                const isMiss = isShot && !isHit;
                const isShip = game.shipCells.has(i);
                const isShipFound = game.isWon && isShip;
                const isShipRevealed = game.isLost && isShip && !isShot;
                const didJustClick = game.lastCell === i && isShot;
                const isExploding = explodingCells.has(i);
                const shipIdx = shipIndexByCell.get(i) ?? null;
                const sunkHullFragment = sunkHullFragmentByCell.get(i);
                const hitHullFragment =
                  isHit && isShip ? hitHullFragmentByCell.get(i) ?? null : null;

                const cellBase =
                  "group relative aspect-square rounded-lg border transform-gpu focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c1526] transition-[background-color,border-color,box-shadow,transform,opacity,filter] duration-300 ease-out active:scale-[0.96]";

                const cellTone = isHit
                  ? // Hit: reward with strong color + subtle pulse.
                    "border-rose-300/85 bg-gradient-to-br from-rose-500/62 via-rose-600/36 to-orange-700/28 shadow-[0_0_30px_rgba(244,63,94,0.52),inset_0_1px_0_rgba(255,255,255,0.14)]"
                  : isShipFound
                    ? // Win: highlight the full ships the player found.
                      shipIdx === 0
                      ? "border-amber-200/75 bg-gradient-to-br from-amber-500/35 via-orange-400/18 to-orange-600/6 shadow-[0_0_34px_rgba(251,191,36,0.40),inset_0_1px_0_rgba(255,255,255,0.15)]"
                      : "border-amber-200/70 bg-gradient-to-br from-amber-500/30 via-amber-300/12 to-orange-600/5 shadow-[0_0_30px_rgba(251,191,36,0.35),inset_0_1px_0_rgba(255,255,255,0.13)]"
                    : isMiss
                      ? // Miss: clear but less intense.
                        "border-slate-400/40 bg-slate-900/35 shadow-[0_2px_10px_rgba(15,23,42,0.26)]"
                      : isShipRevealed
                        ? // Loss: reveal ship positions (but don't overpower confirmed hits).
                          "border-teal-300/25 bg-teal-400/10 shadow-[0_0_22px_rgba(45,212,191,0.18),inset_0_1px_0_rgba(255,255,255,0.10)]"
                        : "border-white/12 bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";

                const cellHover =
                  !isShot && !gameEnded
                    ? "hover:-translate-y-px hover:bg-teal-400/12 hover:border-teal-300/35 hover:shadow-[0_0_20px_rgba(45,212,191,0.12)]"
                    : "";

                const cellInteractivity =
                  isShot || gameEnded
                    ? "cursor-not-allowed"
                    : "";

                const shotDim = isShot && !didJustClick ? "opacity-[0.88]" : "";

                const cellClickAnim = didJustClick
                  ? isHit
                    ? "motion-reduce:animate-none animate-[hit-impact_0.48s_cubic-bezier(0.34,1.45,0.64,1)_forwards]"
                    : "motion-reduce:animate-none animate-[miss-settle_0.45s_ease-out_forwards]"
                  : "";

                const markAnim = isHit
                  ? isExploding
                    ? "motion-reduce:animate-none animate-[explosion-burst_0.3s_ease-out_forwards]"
                    : didJustClick
                      ? "motion-reduce:animate-none animate-[mark-hit_0.4s_cubic-bezier(0.34,1.45,0.64,1)_forwards]"
                      : "transition-opacity duration-300 ease-out"
                  : didJustClick
                    ? "motion-reduce:animate-none animate-[mark-miss_0.45s_ease-out_forwards]"
                    : "transition-opacity duration-300 ease-out";

                const revealAnim = isShipRevealed
                  ? "motion-reduce:animate-none animate-[ship-reveal_0.55s_ease-out_forwards]"
                  : "";

                const winAnim = isShipFound
                  ? "motion-reduce:animate-none animate-[ship-win_0.85s_ease-out_forwards]"
                  : "";

                const cellIcon =
                  isHit
                    ? "text-rose-50"
                    : isShipRevealed
                      ? "text-teal-50/70"
                      : "text-slate-400/95";

                return (
                  <button
                    key={i}
                    type="button"
                    role="gridcell"
                    aria-label={`Cell ${i + 1}${
                      game.isLost && isShip && !isShot
                        ? ", ship revealed"
                        : game.isWon && isShip
                          ? ", ship found"
                          : isHit
                            ? ", hit"
                            : isMiss
                              ? ", miss"
                              : ""
                    }`}
                    disabled={isShot || gameEnded || isResetting}
                    onClick={() => handleCellClick(i)}
                    className={[
                      cellBase,
                      cellTone,
                      cellHover,
                      cellInteractivity,
                      shotDim,
                      cellClickAnim,
                      revealAnim,
                      winAnim,
                    ].join(" ")}
                  >
                    {hitHullFragment && (
                      <ShipHitHullGraphic fragment={hitHullFragment} />
                    )}
                    {sunkHullFragment && (
                      <ShipOutlineWatermark fragment={sunkHullFragment} />
                    )}
                    {isShot && (
                      <span
                        aria-hidden
                        className={[
                          "pointer-events-none absolute inset-0 z-[2] flex items-center justify-center font-bold",
                          isHit && isExploding
                            ? "text-amber-100 drop-shadow-[0_0_16px_rgba(251,191,36,0.95),0_0_32px_rgba(248,113,113,0.55),0_0_48px_rgba(251,146,60,0.35)]"
                            : isHit
                              ? `text-2xl drop-shadow-md ${cellIcon}`
                              : "text-lg font-semibold text-slate-400/95 drop-shadow-md",
                          markAnim,
                        ].join(" ")}
                      >
                        {isHit ? (isExploding ? <ExplosionIcon /> : "✕") : "○"}
                      </span>
                    )}
                    {!isShot && isShipRevealed && (
                      <span
                        aria-hidden
                        className={[
                          "pointer-events-none absolute inset-0 flex items-center justify-center font-bold drop-shadow-md",
                          "text-lg",
                          cellIcon,
                          "opacity-90",
                        ].join(" ")}
                      >
                        ■
                      </span>
                    )}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-lg bg-gradient-to-br from-teal-400/0 via-teal-400/[0.07] to-transparent opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100"
                    />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-stretch gap-2.5 sm:flex-row sm:items-center sm:justify-center sm:gap-3">
          <button
            type="button"
            onClick={handleReset}
            disabled={isResetting}
            aria-busy={isResetting}
            className={[
              "rounded-xl border border-teal-400/25 bg-teal-500/15 px-7 py-3.5 text-sm font-semibold text-teal-50 transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60",
              isResetting
                ? "cursor-wait opacity-70"
                : "hover:bg-teal-500/25 hover:border-teal-300/40 hover:shadow-[0_0_24px_rgba(45,212,191,0.2)] active:scale-[0.98]",
            ].join(" ")}
          >
            {isResetting ? "Starting new game…" : "Reset"}
          </button>
          {gameEnded && (
            <button
              type="button"
              onClick={handlePlayAgain}
              disabled={isResetting}
              aria-busy={isResetting}
              className={[
                "rounded-xl border border-white/15 bg-white/[0.06] px-5 py-2.5 text-xs font-semibold text-slate-200 transition-[background-color,border-color,box-shadow,transform,opacity] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/50",
                isResetting
                  ? "cursor-wait opacity-70"
                  : "hover:border-white/25 hover:bg-white/[0.1] hover:shadow-[0_0_20px_rgba(255,255,255,0.06)] active:scale-[0.98]",
              ].join(" ")}
            >
              {isResetting ? "Starting new game…" : "Play again"}
            </button>
          )}
          <button
            type="button"
            onClick={handleBackToDifficulty}
            disabled={isResetting}
            className="rounded-xl border border-white/10 bg-transparent px-5 py-2.5 text-xs font-semibold text-slate-400 transition-[border-color,color,opacity] duration-200 ease-out hover:border-white/18 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/40 disabled:opacity-50"
          >
            Change difficulty
          </button>
        </div>
          </>
        )}
        </div>
      </section>
    </div>
  );
}

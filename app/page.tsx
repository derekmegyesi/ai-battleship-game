// Game logic + UI wiring (client-side).
"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";

const BOARD_SIZE = 6;
const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE;
/** After this many consecutive misses without a hit, show a subtle tip until the next hit. */
const CONSECUTIVE_MISS_HINT_AFTER = 3;
/** How long we keep the explosion icon visible before revealing the hit mark. */
const EXPLOSION_MS = 300;
/** Fade-out duration before applying a new game (also acts as a short intentional delay). */
const RESET_FADE_OUT_MS = 360;
const RESET_CONFIRM_MESSAGE =
  "Start a new game? Your current board and shots will be cleared.";

/** Silence after any `public/audio` clip ends (ms). */
const PUBLIC_AUDIO_POST_GAP_MS = 500;

const PLAYERS_TURN_AUDIO_SRC = "/audio/players_turn.mp3";
const OPPONENTS_TURN_AUDIO_SRC = "/audio/opponents_turn.mp3";
const SUNK_BATTLESHIP_AUDIO_SRC = "/audio/sunk_battleship.mp3";
const SUNK_FLEET_AUDIO_SRC = "/audio/sunk_fleet.mp3";
const HIT_AUDIO_SRC = "/audio/hit.mp3";
const MISS_AUDIO_SRC = "/audio/miss.mp3";

/**
 * Plays a file from `public/audio`, then waits {@link PUBLIC_AUDIO_POST_GAP_MS}
 * after the clip ends (or if play fails). Returns cleanup (pause + clear timers).
 */
function runAfterPublicAudioClip(
  src: string,
  onAfterGap: () => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const audio = new Audio(src);
  let cancelled = false;
  /** Browser timer id (avoids NodeJS.Timeout vs number under @types/node). */
  let gapTimer: number | null = null;
  let clipComplete = false;

  const scheduleGap = () => {
    if (cancelled || clipComplete) return;
    clipComplete = true;
    gapTimer = window.setTimeout(() => {
      gapTimer = null;
      if (cancelled) return;
      onAfterGap();
    }, PUBLIC_AUDIO_POST_GAP_MS);
  };

  const onEnded = () => {
    scheduleGap();
  };
  const onError = () => {
    scheduleGap();
  };

  audio.addEventListener("ended", onEnded, { once: true });
  audio.addEventListener("error", onError, { once: true });

  void audio.play().catch(() => {
    scheduleGap();
  });

  return () => {
    cancelled = true;
    audio.pause();
    audio.removeEventListener("ended", onEnded);
    audio.removeEventListener("error", onError);
    if (gapTimer !== null) {
      window.clearTimeout(gapTimer);
    }
  };
}

const TURN_CALLOUT_AUDIO_TAG = "turn-callout";

type PublicAudioQueueJob = {
  src: string;
  afterGap: () => void;
  tag?: string;
};

const publicAudioQueue: PublicAudioQueueJob[] = [];
let publicAudioBusy = false;
let publicAudioCurrentCleanup: (() => void) | null = null;
let publicAudioCurrentTag: string | undefined;

function drainPublicAudioQueue(): void {
  if (typeof window === "undefined" || publicAudioBusy) return;
  if (publicAudioQueue.length === 0) return;
  const job = publicAudioQueue.shift()!;
  publicAudioBusy = true;
  publicAudioCurrentTag = job.tag;
  publicAudioCurrentCleanup = runAfterPublicAudioClip(job.src, () => {
    job.afterGap();
    publicAudioCurrentCleanup = null;
    publicAudioCurrentTag = undefined;
    publicAudioBusy = false;
    drainPublicAudioQueue();
  });
}

/**
 * Enqueue one “sound + post-gap” event. The next event does not start until this
 * one fully finishes (like waiting on a child process).
 */
function enqueuePublicAudioEvent(
  src: string,
  afterGap: () => void,
  tag?: string,
): void {
  if (typeof window === "undefined") {
    afterGap();
    return;
  }
  publicAudioQueue.push({ src, afterGap, tag });
  drainPublicAudioQueue();
}

/** Remove pending jobs with `tag` and stop the current clip if it used that tag. */
function cancelPublicAudioJobsWithTag(tag: string): void {
  for (let i = publicAudioQueue.length - 1; i >= 0; i--) {
    if (publicAudioQueue[i]!.tag === tag) {
      publicAudioQueue.splice(i, 1);
    }
  }
  if (
    publicAudioBusy &&
    publicAudioCurrentCleanup &&
    publicAudioCurrentTag === tag
  ) {
    publicAudioCurrentCleanup();
    publicAudioCurrentCleanup = null;
    publicAudioCurrentTag = undefined;
    publicAudioBusy = false;
    drainPublicAudioQueue();
  }
}

/** Clear all queued audio and stop whatever is playing (e.g. new deal / reset). */
function cancelPublicAudioQueue(): void {
  publicAudioQueue.length = 0;
  if (publicAudioCurrentCleanup) {
    publicAudioCurrentCleanup();
    publicAudioCurrentCleanup = null;
  }
  publicAudioCurrentTag = undefined;
  publicAudioBusy = false;
}

/** Turn callout: queued, then `onAfterGap`. Effect cleanup cancels only this tag. */
function runAfterTurnClip(
  which: "player" | "opponent",
  onAfterGap: () => void,
): () => void {
  const src =
    which === "player" ? PLAYERS_TURN_AUDIO_SRC : OPPONENTS_TURN_AUDIO_SRC;
  enqueuePublicAudioEvent(src, onAfterGap, TURN_CALLOUT_AUDIO_TAG);
  return () => cancelPublicAudioJobsWithTag(TURN_CALLOUT_AUDIO_TAG);
}

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

type GameLoopPhase = "setup" | "playerTurn" | "aiTurn" | "gameOver";

/** Whose firing turn it is; always derived from `gamePhase` (and `winner` when `gameOver`). */
function mirroredCurrentTurn(
  gamePhase: GameLoopPhase,
  winner: "player" | "ai" | null,
): "player" | "ai" {
  if (gamePhase === "setup" || gamePhase === "playerTurn") return "player";
  if (gamePhase === "aiTurn") return "ai";
  return winner === "ai" ? "ai" : "player";
}

type ShipModel = {
  positions: readonly number[];
  hits: number;
  size: number;
};

type BattleGameState = {
  /** Bumps on each new deal; used to apply win stats exactly once per game. */
  dealId: number;
  difficulty: Difficulty;
  gamePhase: GameLoopPhase;
  /** Mirrored from `gamePhase` (and `winner` when `gamePhase === "gameOver"`). */
  currentTurn: "player" | "ai";
  playerShips: ShipModel[];
  aiShips: ShipModel[];
  /** Shots the player fired at the AI board (cell indices). */
  playerShots: Set<number>;
  /** Shots the AI fired at the player board (cell indices). */
  aiShots: Set<number>;
  status: string;
  /** Resets to 0 on any player hit on the opponent board; used for optional miss-streak hints. */
  consecutiveMisses: number;
  lastOpponentBoardCell: number | null;
  lastPlayerBoardCell: number | null;
  lastOutcome: OutcomeTone;
  winner: "player" | "ai" | null;
  /** After the turn clip finishes plus post-gap, player may shoot. */
  playerFireEnabled: boolean;
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

function shipsToModels(ships: number[][]): ShipModel[] {
  return ships.map((positions) => ({
    positions,
    hits: 0,
    size: positions.length,
  }));
}

function placePlayerShips(difficulty: Difficulty): ShipModel[] {
  return shipsToModels(generateShipsForDifficulty(difficulty).ships);
}

function placeAiShips(difficulty: Difficulty): ShipModel[] {
  return shipsToModels(generateShipsForDifficulty(difficulty).ships);
}

/** Random valid fleets for both sides (no overlap within each fleet; independent placements). */
function placeShips(difficulty: Difficulty): {
  playerShips: ShipModel[];
  aiShips: ShipModel[];
} {
  return {
    playerShips: placePlayerShips(difficulty),
    aiShips: placeAiShips(difficulty),
  };
}

function isFleetSunk(ships: ShipModel[]): boolean {
  return ships.every((ship) => ship.hits === ship.size);
}

function fleetOccupiedCells(ships: ShipModel[]): Set<number> {
  const s = new Set<number>();
  for (const sh of ships) {
    for (const c of sh.positions) s.add(c);
  }
  return s;
}

function incrementShipHitForCell(ships: ShipModel[], cell: number): ShipModel[] {
  return ships.map((sh) =>
    sh.positions.includes(cell) ? { ...sh, hits: sh.hits + 1 } : sh,
  );
}

/** True when this hit is the last uncovered cell of that ship. */
function isSinkingHitForCell(ships: ShipModel[], cell: number): boolean {
  return ships.some(
    (sh) => sh.positions.includes(cell) && sh.hits === sh.size - 1,
  );
}

function checkWin(
  playerShips: ShipModel[],
  aiShips: ShipModel[],
): "player" | "ai" | null {
  if (isFleetSunk(aiShips)) return "player";
  if (isFleetSunk(playerShips)) return "ai";
  return null;
}

function createBattleState(difficulty: Difficulty): BattleGameState {
  const { playerShips, aiShips } = placeShips(difficulty);
  const dealId = nextDealId++;
  return {
    dealId,
    difficulty,
    gamePhase: "setup",
    currentTurn: mirroredCurrentTurn("setup", null),
    playerShips,
    aiShips,
    playerShots: new Set<number>(),
    aiShots: new Set<number>(),
    status: "Randomize your ships, then start the battle.",
    consecutiveMisses: 0,
    lastOpponentBoardCell: null,
    lastPlayerBoardCell: null,
    lastOutcome: "ready",
    winner: null,
    playerFireEnabled: false,
  };
}

/** True when at least one AI ship has been hit but not yet fully sunk. */
function hasActiveHunt(game: BattleGameState): boolean {
  return game.aiShips.some(
    (ship) => ship.hits > 0 && ship.hits < ship.size,
  );
}

/** Short rule-based hint from the current board (reflects the latest move). */
function assistantTipForGame(game: BattleGameState): string {
  if (game.winner === "player") {
    return "You sank their fleet — play again for a new layout.";
  }
  if (game.winner === "ai") {
    return "They found your ships first. Randomize and try a different formation.";
  }
  if (game.gamePhase === "setup") {
    return "Use Randomize until you're happy, then start the battle.";
  }
  if (game.gamePhase === "aiTurn") {
    return "Wait for the opponent's shot — watch your board.";
  }
  if (game.gamePhase === "playerTurn" && !game.playerFireEnabled) {
    return "Stand by — you'll be able to fire right after the callout.";
  }
  if (
    game.gamePhase === "playerTurn" &&
    game.playerFireEnabled &&
    game.playerShots.size === 0
  ) {
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

function applyPlayerFire(
  prev: BattleGameState,
  cellIndex: number,
): BattleGameState {
  const playerShots = new Set(prev.playerShots);
  playerShots.add(cellIndex);
  const onShip = prev.aiShips.some((s) => s.positions.includes(cellIndex));
  if (!onShip) {
    return {
      ...prev,
      playerShots,
      consecutiveMisses: prev.consecutiveMisses + 1,
      lastOpponentBoardCell: cellIndex,
      lastOutcome: "miss",
      status: "Miss!",
      gamePhase: "aiTurn",
      currentTurn: mirroredCurrentTurn("aiTurn", prev.winner),
      winner: prev.winner,
      playerFireEnabled: false,
    };
  }
  const aiShips = incrementShipHitForCell(prev.aiShips, cellIndex);
  const winner = checkWin(prev.playerShips, aiShips);
  const nextPhase: GameLoopPhase = winner ? "gameOver" : "aiTurn";
  const nextWinner = winner ?? prev.winner;
  return {
    ...prev,
    playerShots,
    aiShips,
    consecutiveMisses: 0,
    lastOpponentBoardCell: cellIndex,
    lastOutcome: winner === "player" ? "sunk" : "hit",
    status: winner === "player" ? "You sank their fleet!" : "Hit!",
    gamePhase: nextPhase,
    currentTurn: mirroredCurrentTurn(nextPhase, nextWinner),
    winner: nextWinner,
    playerFireEnabled: false,
  };
}

function applyAiFire(prev: BattleGameState, cellIndex: number): BattleGameState {
  const aiShots = new Set(prev.aiShots);
  aiShots.add(cellIndex);
  const onShip = prev.playerShips.some((s) => s.positions.includes(cellIndex));
  if (!onShip) {
    return {
      ...prev,
      aiShots,
      lastPlayerBoardCell: cellIndex,
      lastOutcome: "miss",
      status: "They missed.",
      gamePhase: "playerTurn",
      currentTurn: mirroredCurrentTurn("playerTurn", prev.winner),
      playerFireEnabled: false,
    };
  }
  const playerShips = incrementShipHitForCell(prev.playerShips, cellIndex);
  const winner = checkWin(playerShips, prev.aiShips);
  const nextPhase: GameLoopPhase = winner ? "gameOver" : "playerTurn";
  const nextWinner = winner ?? prev.winner;
  return {
    ...prev,
    aiShots,
    playerShips,
    lastPlayerBoardCell: cellIndex,
    lastOutcome: winner === "ai" ? "lost" : "hit",
    status:
      winner === "ai" ? "They sank your fleet!" : "They hit your ship!",
    gamePhase: nextPhase,
    currentTurn: mirroredCurrentTurn(nextPhase, nextWinner),
    winner: nextWinner,
    playerFireEnabled: false,
  };
}

function pickRandomUnshotCell(shots: Set<number>): number {
  const avail: number[] = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    if (!shots.has(i)) avail.push(i);
  }
  return randPick(avail);
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

/** White hull strokes only when a ship is fully sunk — avoids revealing orientation on partial hits. */
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

function explosionKey(board: "opponent" | "player", cell: number) {
  return `${board}:${cell}`;
}

export default function Home() {
  const cells = useMemo(() => Array.from({ length: TOTAL_CELLS }, (_, i) => i), []);
  const [phase, setPhase] = useState<"setup" | "playing">("setup");
  const [pendingDifficulty, setPendingDifficulty] = useState<Difficulty>("medium");
  const [game, setGame] = useState<BattleGameState | null>(null);
  const stats = useSyncExternalStore(
    subscribeStatsStore,
    getStatsStoreSnapshot,
    () => SERVER_STATS_SNAPSHOT,
  );
  const [explodingCells, setExplodingCells] = useState<Set<string>>(
    () => new Set(),
  );
  const explosionTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const boomShotKeysRef = useRef<Set<string>>(new Set());
  const [resetAnim, setResetAnim] = useState<ResetAnimPhase>("idle");
  const resetFadeOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameRef = useRef<BattleGameState | null>(null);
  /** Latest game for event handlers (synced during render — avoids useEffect lag vs state). */
  gameRef.current = game;
  /** Locks opponent grid until shot SFX queue finishes (flushSync so repeat clicks don’t slip through). */
  const [opponentShotUiLocked, setOpponentShotUiLocked] = useState(false);

  useEffect(() => {
    if (game?.winner !== "player") return;
    const fingerprint = `${game.dealId}-${game.playerShots.size}`;
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
    const shotsUsed = game.playerShots.size;
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
  }, [game?.winner, game?.playerShots.size, game?.dealId]);

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

  const aiShipIndexByCell = useMemo(() => {
    const map = new Map<number, number>();
    if (!game) return map;
    game.aiShips.forEach((sh, shipIdx) => {
      sh.positions.forEach((cell) => map.set(cell, shipIdx));
    });
    return map;
  }, [game]);

  const playerShipIndexByCell = useMemo(() => {
    const map = new Map<number, number>();
    if (!game) return map;
    game.playerShips.forEach((sh, shipIdx) => {
      sh.positions.forEach((cell) => map.set(cell, shipIdx));
    });
    return map;
  }, [game]);

  const sunkAiHullByCell = useMemo(() => {
    const map = new Map<number, HullFragment>();
    if (!game) return map;
    for (const ship of game.aiShips) {
      if (ship.hits < ship.size) continue;
      hullFragmentsForShipCells([...ship.positions]).forEach((frag, cell) =>
        map.set(cell, frag),
      );
    }
    return map;
  }, [game]);

  const sunkPlayerHullByCell = useMemo(() => {
    const map = new Map<number, HullFragment>();
    if (!game) return map;
    for (const ship of game.playerShips) {
      if (ship.hits < ship.size) continue;
      hullFragmentsForShipCells([...ship.positions]).forEach((frag, cell) =>
        map.set(cell, frag),
      );
    }
    return map;
  }, [game]);

  const triggerExplosion = (key: string) => {
    setExplodingCells((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

    const existing = explosionTimersRef.current.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      setExplodingCells((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      explosionTimersRef.current.delete(key);
    }, EXPLOSION_MS);

    explosionTimersRef.current.set(key, timer);
  };

  /** Fixed-length deps so React Fast Refresh never sees a changing hook-input arity. */
  const turnEffectDeps = [
    game,
    game?.dealId,
    game?.gamePhase,
    game?.winner,
    game?.playerShots.size,
    game?.aiShots.size,
    game?.playerFireEnabled,
  ] as const;

  useEffect(() => {
    if (!game || game.gamePhase !== "aiTurn" || game.winner) return;
    const dealId = game.dealId;
    const playerShotsAtStart = game.playerShots.size;
    return runAfterTurnClip("opponent", () => {
      const prev = gameRef.current;
      if (
        !prev ||
        prev.gamePhase !== "aiTurn" ||
        prev.winner ||
        prev.dealId !== dealId ||
        prev.playerShots.size !== playerShotsAtStart
      ) {
        return;
      }
      const cell = pickRandomUnshotCell(prev.aiShots);
      const willHit = prev.playerShips.some((s) => s.positions.includes(cell));
      const commitAiShot = () => {
        const p = gameRef.current;
        if (
          !p ||
          p.gamePhase !== "aiTurn" ||
          p.winner ||
          p.dealId !== dealId ||
          p.playerShots.size !== playerShotsAtStart
        ) {
          return;
        }
        setGame(applyAiFire(p, cell));
      };
      if (willHit) {
        const boomKey = `p:${cell}-${prev.aiShots.size}`;
        if (!boomShotKeysRef.current.has(boomKey)) {
          boomShotKeysRef.current.add(boomKey);
          triggerExplosion(explosionKey("player", cell));
        }
        const sinking = isSinkingHitForCell(prev.playerShips, cell);
        const previewNext = applyAiFire(prev, cell);
        enqueuePublicAudioEvent(HIT_AUDIO_SRC, () => {
          if (sinking) {
            enqueuePublicAudioEvent(SUNK_BATTLESHIP_AUDIO_SRC, () => {
              if (previewNext.winner === "ai") {
                enqueuePublicAudioEvent(SUNK_FLEET_AUDIO_SRC, commitAiShot);
              } else {
                commitAiShot();
              }
            });
          } else {
            commitAiShot();
          }
        });
        return;
      }
      enqueuePublicAudioEvent(MISS_AUDIO_SRC, commitAiShot);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- use turnEffectDeps tuple above
  }, turnEffectDeps);

  useEffect(() => {
    if (!game || game.gamePhase !== "playerTurn" || game.winner) return;
    if (game.playerFireEnabled) return;
    const dealId = game.dealId;
    const aiShotsAtStart = game.aiShots.size;
    return runAfterTurnClip("player", () => {
      setGame((prev) => {
        if (
          !prev ||
          prev.gamePhase !== "playerTurn" ||
          prev.winner ||
          prev.dealId !== dealId ||
          prev.aiShots.size !== aiShotsAtStart
        ) {
          return prev;
        }
        if (prev.playerFireEnabled) return prev;
        return { ...prev, playerFireEnabled: true };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- use turnEffectDeps tuple above
  }, turnEffectDeps);

  const handleOpponentCellClick = (cellIndex: number) => {
    if (resetAnim !== "idle") return;
    const g = gameRef.current;
    if (!g) return;
    if (g.gamePhase !== "playerTurn" || g.winner) return;
    if (!g.playerFireEnabled) return;
    if (g.playerShots.has(cellIndex)) return;
    if (opponentShotUiLocked) return;

    flushSync(() => {
      setOpponentShotUiLocked(true);
    });

    const finishPlayerShot = () => {
      try {
        setGame((prev) => {
          if (!prev || prev.gamePhase !== "playerTurn" || prev.winner) return prev;
          if (!prev.playerFireEnabled) return prev;
          if (prev.playerShots.has(cellIndex)) return prev;
          return applyPlayerFire(prev, cellIndex);
        });
      } finally {
        setOpponentShotUiLocked(false);
      }
    };

    const willBeHit = g.aiShips.some((s) => s.positions.includes(cellIndex));
    if (willBeHit) {
      const boomKey = `o:${cellIndex}-${g.playerShots.size}`;
      if (!boomShotKeysRef.current.has(boomKey)) {
        boomShotKeysRef.current.add(boomKey);
        triggerExplosion(explosionKey("opponent", cellIndex));
      }
      const sinking = isSinkingHitForCell(g.aiShips, cellIndex);
      const previewNext = applyPlayerFire(g, cellIndex);
      enqueuePublicAudioEvent(HIT_AUDIO_SRC, () => {
        if (sinking) {
          enqueuePublicAudioEvent(SUNK_BATTLESHIP_AUDIO_SRC, () => {
            if (previewNext.winner === "player") {
              enqueuePublicAudioEvent(SUNK_FLEET_AUDIO_SRC, finishPlayerShot);
            } else {
              finishPlayerShot();
            }
          });
        } else {
          finishPlayerShot();
        }
      });
      return;
    }

    enqueuePublicAudioEvent(MISS_AUDIO_SRC, finishPlayerShot);
  };

  const applyNewGameState = () => {
    explosionTimersRef.current.forEach((t) => clearTimeout(t));
    explosionTimersRef.current.clear();
    setExplodingCells(new Set());
    boomShotKeysRef.current.clear();
    setOpponentShotUiLocked(false);
    cancelPublicAudioQueue();
    const d = game?.difficulty ?? pendingDifficulty;
    setGame(createBattleState(d));
  };

  const startNewGameWithTransition = (requireConfirm: boolean) => {
    if (resetAnim !== "idle") return;
    if (!game) return;

    const hasProgress =
      game.gamePhase !== "setup" ||
      game.winner !== null ||
      game.playerShots.size > 0 ||
      game.aiShots.size > 0;
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

  const handleRestartGame = () => startNewGameWithTransition(false);

  const handleStartFromSetup = () => {
    setGame(createBattleState(pendingDifficulty));
    setPhase("playing");
  };

  const canRedealSamePhase =
    game !== null && game.gamePhase === "setup" && game.winner === null;

  const applyDifficultyInSetup = (d: Difficulty) => {
    setPendingDifficulty(d);
    if (canRedealSamePhase) {
      setGame(createBattleState(d));
    }
  };

  const handleRandomizeShips = () => {
    if (!game || resetAnim !== "idle") return;
    if (game.gamePhase !== "setup") return;
    setGame((prev) => {
      if (!prev || prev.gamePhase !== "setup") return prev;
      return {
        ...prev,
        playerShips: placePlayerShips(prev.difficulty),
        status: "Fleet randomized — start when ready.",
        lastOutcome: "ready",
      };
    });
  };

  const handleStartBattle = () => {
    if (!game || resetAnim !== "idle") return;
    if (game.gamePhase !== "setup") return;
    setGame((prev) => {
      if (!prev || prev.gamePhase !== "setup") return prev;
      return {
        ...prev,
        gamePhase: "playerTurn",
        currentTurn: mirroredCurrentTurn("playerTurn", null),
        playerFireEnabled: false,
        status: "Your turn — pick a cell on the opponent board.",
        lastOutcome: "ready",
      };
    });
  };

  const handleBackToDifficulty = () => {
    if (!game) {
      setPhase("setup");
      return;
    }
    const hasProgress =
      game.gamePhase !== "setup" ||
      game.winner !== null ||
      game.playerShots.size > 0 ||
      game.aiShots.size > 0;
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

  const aiOccupiedCells = useMemo(
    () => (game ? fleetOccupiedCells(game.aiShips) : new Set<number>()),
    [game],
  );
  const playerOccupiedCells = useMemo(
    () => (game ? fleetOccupiedCells(game.playerShips) : new Set<number>()),
    [game],
  );

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

  const gameEnded = game ? game.winner !== null : false;
  const winFingerprint =
    game?.winner === "player"
      ? `${game.dealId}-${game.playerShots.size}`
      : null;
  const storedWinFlair = readStoredWinFlair(winFingerprint);
  const beatPersonalBest =
    !!game &&
    game.winner === "player" &&
    (storedWinFlair?.newBest === true ||
      (storedWinFlair === null &&
        (stats.bestShots === null ||
          game.playerShots.size < stats.bestShots)));
  const wonAboveBestRecord =
    !!game &&
    game.winner === "player" &&
    stats.bestShots !== null &&
    game.playerShots.size > stats.bestShots;
  const showShipAdjacencyHint =
    !!game &&
    !gameEnded &&
    game.gamePhase === "playerTurn" &&
    game.playerFireEnabled &&
    game.consecutiveMisses >= CONSECUTIVE_MISS_HINT_AFTER &&
    resetAnim === "idle";
  const isResetting = resetAnim !== "idle";

  const turnIndicator =
    !game || game.gamePhase === "setup"
      ? "Arrange your fleet"
      : game.gamePhase === "aiTurn"
        ? "Stand by"
        : game.gamePhase === "playerTurn" && !game.playerFireEnabled
          ? "Stand by"
          : game.gamePhase === "playerTurn"
            ? "Your Turn"
            : "Stand by";

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
          Sink the enemy fleet before they sink yours
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
        {game.winner === "player" && (
          <div className="w-full mb-5 rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/15 to-orange-600/10 px-5 py-4 shadow-[0_0_48px_rgba(251,191,36,0.15)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-lg font-bold tracking-tight text-amber-100">
                  You Win!
                </div>
                <div className="mt-1 text-sm text-slate-300">
                  {beatPersonalBest ? (
                    <span className="text-amber-100/95">
                      New personal best — fewer shots to win.
                    </span>
                  ) : wonAboveBestRecord ? (
                    <>
                      Your best is {stats.bestShots} shot
                      {stats.bestShots === 1 ? "" : "s"}. Try again?
                    </>
                  ) : (
                    <span>All enemy ships sunk.</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={handleRestartGame}
                disabled={isResetting}
                className="shrink-0 rounded-xl border border-amber-300/40 bg-amber-500/15 px-5 py-2.5 text-sm font-semibold text-amber-50 transition-[background-color,border-color] duration-200 hover:bg-amber-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 disabled:opacity-60"
              >
                Restart Game
              </button>
            </div>
          </div>
        )}
        {game.winner === "ai" && (
          <div className="w-full mb-5 rounded-2xl border border-red-500/35 bg-gradient-to-br from-red-950/40 to-slate-950/50 px-5 py-4 shadow-[0_0_48px_rgba(239,68,68,0.12)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-lg font-bold tracking-tight text-red-100">
                  You Lose!
                </div>
                <div className="mt-1 text-sm text-slate-400">
                  The opponent sank your fleet first.
                </div>
              </div>
              <button
                type="button"
                onClick={handleRestartGame}
                disabled={isResetting}
                className="shrink-0 rounded-xl border border-red-400/35 bg-red-500/15 px-5 py-2.5 text-sm font-semibold text-red-50 transition-[background-color,border-color] duration-200 hover:bg-red-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50 disabled:opacity-60"
              >
                Restart Game
              </button>
            </div>
          </div>
        )}
        <div
          className="w-full rounded-2xl border border-white/12 bg-white/[0.06] backdrop-blur-sm px-5 py-5 sm:px-6 sm:py-6 shadow-[0_8px_40px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex flex-1 flex-col gap-1 min-h-[2.75rem] sm:min-h-0">
              {!gameEnded && (
                <p className="text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-300/90 sm:text-left">
                  {turnIndicator}
                </p>
              )}
              <div className="flex items-center justify-center gap-3 sm:justify-start">
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
            </div>
            <div className="flex flex-col items-center gap-1 sm:items-end">
              <span className="text-center sm:text-right text-xs font-semibold uppercase tracking-wider text-slate-500 tabular-nums">
                6×6
              </span>
            </div>
          </div>
          {canRedealSamePhase && (
            <div className="mt-4 flex flex-col gap-3 border-t border-white/[0.08] pt-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
                <button
                  type="button"
                  onClick={handleRandomizeShips}
                  disabled={isResetting}
                  className="w-full rounded-xl border border-white/15 bg-white/[0.06] px-4 py-2.5 text-sm font-semibold text-slate-100 transition-[background-color,border-color] duration-200 hover:border-teal-300/35 hover:bg-teal-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/50 sm:w-auto"
                >
                  Randomize ships
                </button>
                <button
                  type="button"
                  onClick={handleStartBattle}
                  disabled={isResetting}
                  className="w-full rounded-xl border border-teal-400/35 bg-teal-500/20 px-4 py-2.5 text-sm font-semibold text-teal-50 transition-[background-color,border-color] duration-200 hover:bg-teal-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60 sm:w-auto"
                >
                  Start battle
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <span className="w-full text-center text-[10px] font-semibold uppercase tracking-wider text-slate-500 sm:w-auto">
                  Difficulty
                </span>
                <div
                  className="flex flex-wrap justify-center gap-1.5"
                  role="group"
                  aria-label="Fleet difficulty"
                >
                  {DIFFICULTY_ORDER.map((d) => {
                    const active = game.difficulty === d;
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => applyDifficultyInSetup(d)}
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

        <div className="mt-7 w-full flex flex-col items-center gap-8">
          <div
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-slate-400"
            aria-label={`Legend: hit and miss colors${
              game.winner === "ai" ? ", ship revealed" : ""
            }`}
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
            {game.winner === "ai" && (
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-4 w-4 shrink-0 rounded border border-teal-300/25 bg-teal-400/10 shadow-[0_0_12px_rgba(45,212,191,0.18)]"
                  aria-hidden
                />
                <span>Ship (revealed)</span>
              </span>
            )}
          </div>

          <div className="w-full flex flex-col gap-2">
            <div className="text-center text-xs font-semibold tracking-[0.2em] uppercase text-slate-500">
              Opponent board
            </div>
            <div
              className="mx-auto w-full max-w-[min(92vw,420px)] rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
              aria-hidden
            >
              <div
                role="grid"
                aria-label="Opponent battleship grid"
                aria-busy={opponentShotUiLocked}
                aria-disabled={
                  gameEnded ||
                  isResetting ||
                  opponentShotUiLocked ||
                  game.gamePhase !== "playerTurn" ||
                  !game.playerFireEnabled
                }
                className={[
                  "mx-auto grid w-full max-w-[min(100%,360px)] grid-cols-6 gap-2 sm:gap-2",
                  gameEnded ||
                  isResetting ||
                  opponentShotUiLocked ||
                  game.gamePhase !== "playerTurn" ||
                  !game.playerFireEnabled
                    ? "pointer-events-none"
                    : "",
                ].join(" ")}
              >
                {cells.map((i) => {
                  const isShot = game.playerShots.has(i);
                  const isHit = isShot && aiOccupiedCells.has(i);
                  const isMiss = isShot && !isHit;
                  const isShip = aiOccupiedCells.has(i);
                  const isShipFound = game.winner === "player" && isShip;
                  const isShipRevealed =
                    game.winner === "ai" && isShip && !isShot;
                  const didJustClick =
                    game.lastOpponentBoardCell === i && isShot;
                  const isExploding = explodingCells.has(
                    explosionKey("opponent", i),
                  );
                  const shipIdx = aiShipIndexByCell.get(i) ?? null;
                  const sunkHullFragment = sunkAiHullByCell.get(i);

                  const cellBase =
                    "group relative aspect-square rounded-lg border transform-gpu focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0c1526] transition-[background-color,border-color,box-shadow,transform,opacity,filter] duration-300 ease-out active:scale-[0.96]";

                  const cellTone = isHit
                    ? "border-rose-300/85 bg-gradient-to-br from-rose-500/62 via-rose-600/36 to-orange-700/28 shadow-[0_0_30px_rgba(244,63,94,0.52),inset_0_1px_0_rgba(255,255,255,0.14)]"
                    : isShipFound
                      ? shipIdx === 0
                        ? "border-amber-200/75 bg-gradient-to-br from-amber-500/35 via-orange-400/18 to-orange-600/6 shadow-[0_0_34px_rgba(251,191,36,0.40),inset_0_1px_0_rgba(255,255,255,0.15)]"
                        : "border-amber-200/70 bg-gradient-to-br from-amber-500/30 via-amber-300/12 to-orange-600/5 shadow-[0_0_30px_rgba(251,191,36,0.35),inset_0_1px_0_rgba(255,255,255,0.13)]"
                      : isMiss
                        ? "border-slate-400/40 bg-slate-900/35 shadow-[0_2px_10px_rgba(15,23,42,0.26)]"
                        : isShipRevealed
                          ? "border-teal-300/25 bg-teal-400/10 shadow-[0_0_22px_rgba(45,212,191,0.18),inset_0_1px_0_rgba(255,255,255,0.10)]"
                          : "border-white/12 bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";

                  const oppInteractive =
                    game.gamePhase === "playerTurn" &&
                    game.playerFireEnabled &&
                    !gameEnded &&
                    !opponentShotUiLocked;
                  const cellHover =
                    !isShot && oppInteractive
                      ? "hover:-translate-y-px hover:bg-teal-400/12 hover:border-teal-300/35 hover:shadow-[0_0_20px_rgba(45,212,191,0.12)]"
                      : "";

                  const cellInteractivity =
                    isShot || !oppInteractive || gameEnded
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
                      key={`o-${i}`}
                      type="button"
                      role="gridcell"
                      aria-label={`Opponent cell ${i + 1}${
                        game.winner === "ai" && isShip && !isShot
                          ? ", ship revealed"
                          : game.winner === "player" && isShip
                            ? ", ship found"
                            : isHit
                              ? ", hit"
                              : isMiss
                                ? ", miss"
                                : ""
                      }`}
                      disabled={
                        isShot ||
                        gameEnded ||
                        isResetting ||
                        opponentShotUiLocked ||
                        game.gamePhase !== "playerTurn" ||
                        !game.playerFireEnabled
                      }
                      onClick={() => handleOpponentCellClick(i)}
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

          <div className="w-full flex flex-col gap-2">
            <div className="text-center text-xs font-semibold tracking-[0.2em] uppercase text-slate-500">
              Your board
            </div>
            <div
              className="mx-auto w-full max-w-[min(92vw,420px)] rounded-2xl border border-white/10 bg-white/[0.04] p-4 sm:p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
              aria-hidden
            >
              <div
                role="grid"
                aria-label="Your battleship grid"
                aria-disabled
                className="mx-auto grid w-full max-w-[min(100%,360px)] grid-cols-6 gap-2 sm:gap-2 pointer-events-none"
              >
                {cells.map((i) => {
                  const isShot = game.aiShots.has(i);
                  const isHit = isShot && playerOccupiedCells.has(i);
                  const isMiss = isShot && !isHit;
                  const isOwnShip = playerOccupiedCells.has(i);
                  const didJustFire = game.lastPlayerBoardCell === i && isShot;
                  const isExploding = explodingCells.has(
                    explosionKey("player", i),
                  );
                  const shipIdx = playerShipIndexByCell.get(i) ?? null;
                  const sunkHullFragment = sunkPlayerHullByCell.get(i);

                  const cellBase =
                    "group relative aspect-square rounded-lg border transform-gpu transition-[background-color,border-color,box-shadow,transform,opacity,filter] duration-300 ease-out";

                  const cellTone = isHit
                    ? "border-rose-300/85 bg-gradient-to-br from-rose-500/62 via-rose-600/36 to-orange-700/28 shadow-[0_0_30px_rgba(244,63,94,0.52),inset_0_1px_0_rgba(255,255,255,0.14)]"
                    : isMiss
                      ? "border-slate-400/40 bg-slate-900/35 shadow-[0_2px_10px_rgba(15,23,42,0.26)]"
                      : isOwnShip
                        ? shipIdx === 0
                          ? "border-teal-300/30 bg-teal-400/12 shadow-[0_0_22px_rgba(45,212,191,0.15),inset_0_1px_0_rgba(255,255,255,0.08)]"
                          : "border-teal-300/25 bg-teal-400/10 shadow-[0_0_18px_rgba(45,212,191,0.12),inset_0_1px_0_rgba(255,255,255,0.06)]"
                        : "border-white/12 bg-white/[0.07] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";

                  const shotDim =
                    isShot && !didJustFire ? "opacity-[0.88]" : "";

                  const cellClickAnim = didJustFire
                    ? isHit
                      ? "motion-reduce:animate-none animate-[hit-impact_0.48s_cubic-bezier(0.34,1.45,0.64,1)_forwards]"
                      : "motion-reduce:animate-none animate-[miss-settle_0.45s_ease-out_forwards]"
                    : "";

                  const markAnim = isHit
                    ? isExploding
                      ? "motion-reduce:animate-none animate-[explosion-burst_0.3s_ease-out_forwards]"
                      : didJustFire
                        ? "motion-reduce:animate-none animate-[mark-hit_0.4s_cubic-bezier(0.34,1.45,0.64,1)_forwards]"
                        : "transition-opacity duration-300 ease-out"
                    : didJustFire
                      ? "motion-reduce:animate-none animate-[mark-miss_0.45s_ease-out_forwards]"
                      : "transition-opacity duration-300 ease-out";

                  const cellIcon =
                    isHit
                      ? "text-rose-50"
                      : isOwnShip && !isShot
                        ? "text-teal-50/70"
                        : "text-slate-400/95";

                  return (
                    <div
                      key={`p-${i}`}
                      role="gridcell"
                      aria-label={`Your cell ${i + 1}${
                        isHit ? ", hit" : isMiss ? ", miss" : isOwnShip ? ", your ship" : ""
                      }`}
                      className={[
                        cellBase,
                        cellTone,
                        shotDim,
                        cellClickAnim,
                      ].join(" ")}
                    >
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
                      {!isShot && isOwnShip && (
                        <span
                          aria-hidden
                          className={[
                            "pointer-events-none absolute inset-0 flex items-center justify-center font-bold drop-shadow-md text-lg opacity-80",
                            cellIcon,
                          ].join(" ")}
                        >
                          ■
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
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

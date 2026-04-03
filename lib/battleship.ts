/** Pure battleship rules + state transitions (no React). */

export const BOARD_SIZE = 10;
export const TOTAL_CELLS = BOARD_SIZE * BOARD_SIZE;

/** After this many consecutive misses without a hit, show a subtle tip until the next hit. */
export const CONSECUTIVE_MISS_HINT_AFTER = 3;

/** Classic fleet; each cell belongs to at most one ship. */
export const SHIPS = [
  { name: "Carrier", size: 5 },
  { name: "Battleship", size: 4 },
  { name: "Cruiser", size: 3 },
  { name: "Submarine", size: 3 },
  { name: "Destroyer", size: 2 },
] as const;

export const EXPECTED_SHIP_CELL_COUNT = SHIPS.reduce((sum, s) => sum + s.size, 0);

export function assertEveryCellBelongsToAtMostOneShip(shipCells: Set<number>): void {
  if (shipCells.size !== EXPECTED_SHIP_CELL_COUNT) {
    throw new Error(
      `Invalid ship layout: need ${EXPECTED_SHIP_CELL_COUNT} distinct cells (no shared cells); got ${shipCells.size}.`,
    );
  }
}

export type OutcomeTone = "ready" | "miss" | "hit" | "sunk" | "lost";

export type Difficulty = "easy" | "medium" | "hard";

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

export type GameLoopPhase = "setup" | "playerTurn" | "aiTurn" | "gameOver";

/** Whose firing turn it is; always derived from `gamePhase` (and `winner` when `gameOver`). */
export function mirroredCurrentTurn(
  gamePhase: GameLoopPhase,
  winner: "player" | "ai" | null,
): "player" | "ai" {
  if (gamePhase === "setup" || gamePhase === "playerTurn") return "player";
  if (gamePhase === "aiTurn") return "ai";
  return winner === "ai" ? "ai" : "player";
}

export type ShipModel = {
  positions: readonly number[];
  hits: number;
  size: number;
};

export type BattleGameState = {
  dealId: number;
  difficulty: Difficulty;
  gamePhase: GameLoopPhase;
  currentTurn: "player" | "ai";
  playerShips: ShipModel[];
  aiShips: ShipModel[];
  playerShots: Set<number>;
  aiShots: Set<number>;
  status: string;
  consecutiveMisses: number;
  lastOpponentBoardCell: number | null;
  lastPlayerBoardCell: number | null;
  lastOutcome: OutcomeTone;
  winner: "player" | "ai" | null;
  playerFireEnabled: boolean;
};

function randPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function cellRowCol(cell: number): { row: number; col: number } {
  return { row: Math.floor(cell / BOARD_SIZE), col: cell % BOARD_SIZE };
}

/** True if this cell is on another ship or touches one orthogonally or diagonally (king-adjacent). */
export function cellTouchesFleet(cell: number, fleetOccupied: Set<number>): boolean {
  const { row: r1, col: c1 } = cellRowCol(cell);
  for (const other of fleetOccupied) {
    const { row: r2, col: c2 } = cellRowCol(other);
    const dr = Math.abs(r1 - r2);
    const dc = Math.abs(c1 - c2);
    if (dr <= 1 && dc <= 1) return true;
  }
  return false;
}

/**
 * Straight segment on one axis only, in-bounds, contiguous in index space — never
 * “wraps” from one board edge to the opposite (e.g. last column → first column).
 */
export function assertShipCellsAreStraightLineNoWrap(cells: readonly number[]): void {
  if (cells.length === 0) {
    throw new Error("Invalid ship: empty cells.");
  }
  for (const c of cells) {
    if (c < 0 || c >= TOTAL_CELLS) {
      throw new Error(`Invalid ship: cell ${c} out of bounds.`);
    }
  }
  const rows = cells.map((c) => Math.floor(c / BOARD_SIZE));
  const cols = cells.map((c) => c % BOARD_SIZE);
  const horizontal = new Set(rows).size === 1;
  const vertical = new Set(cols).size === 1;
  if (!horizontal && !vertical) {
    throw new Error(
      "Invalid ship: must be a straight horizontal or vertical line (no diagonal, no wrap).",
    );
  }
  const sorted = [...cells].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (horizontal) {
      if (cur !== prev + 1) {
        throw new Error(
          "Invalid ship: horizontal cells must be contiguous on one row (no edge wrap).",
        );
      }
    } else if (cur !== prev + BOARD_SIZE) {
      throw new Error(
        "Invalid ship: vertical cells must be contiguous on one column (no edge wrap).",
      );
    }
  }
}

/**
 * Validates a full fleet: ship sizes, straight segments, no overlap, king-spacing between ships.
 * @throws Error if invalid
 */
export function assertValidFleetLayout(placements: number[][]): void {
  if (placements.length !== SHIPS.length) {
    throw new Error(`Expected ${SHIPS.length} ships, got ${placements.length}.`);
  }
  const occupied = new Set<number>();
  for (let i = 0; i < placements.length; i++) {
    const ship = placements[i]!;
    if (ship.length !== SHIPS[i]!.size) {
      throw new Error(
        `Ship ${i} (${SHIPS[i]!.name}) expected length ${SHIPS[i]!.size}, got ${ship.length}.`,
      );
    }
    assertShipCellsAreStraightLineNoWrap(ship);
    for (const c of ship) {
      if (occupied.has(c)) {
        throw new Error(`Overlapping cell ${c}.`);
      }
      if (cellTouchesFleet(c, occupied)) {
        throw new Error(`Cell ${c} touches another ship (need a gap).`);
      }
    }
    for (const c of ship) occupied.add(c);
  }
  assertEveryCellBelongsToAtMostOneShip(occupied);
}

/** Every straight horizontal/vertical segment of length `size` that fits king-spacing vs `occupied`. */
function validShipPlacements(size: number, occupied: Set<number>): number[][] {
  const out: number[][] = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col <= BOARD_SIZE - size; col++) {
      const cells: number[] = [];
      let ok = true;
      for (let i = 0; i < size; i++) {
        const c = row * BOARD_SIZE + col + i;
        if (cellTouchesFleet(c, occupied)) {
          ok = false;
          break;
        }
        cells.push(c);
      }
      if (ok) out.push(cells);
    }
  }
  for (let row = 0; row <= BOARD_SIZE - size; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const cells: number[] = [];
      let ok = true;
      for (let i = 0; i < size; i++) {
        const c = (row + i) * BOARD_SIZE + col;
        if (cellTouchesFleet(c, occupied)) {
          ok = false;
          break;
        }
        cells.push(c);
      }
      if (ok) out.push(cells);
    }
  }
  return out;
}

/**
 * Places {@link SHIPS} in order; each ship is chosen uniformly among all valid
 * segments (horizontal and vertical) given prior ships. No overlap, king-spacing
 * between ships. Retries the full fleet if a ship has no valid slot.
 */
export function generateRandomFleet(): number[][] {
  const maxFleetAttempts = 500;

  for (let fleetTry = 0; fleetTry < maxFleetAttempts; fleetTry++) {
    const occupied = new Set<number>();
    const placements: number[][] = [];
    let fleetOk = true;

    for (const ship of SHIPS) {
      const options = validShipPlacements(ship.size, occupied);
      if (options.length === 0) {
        fleetOk = false;
        break;
      }
      const cells = randPick(options);
      assertShipCellsAreStraightLineNoWrap(cells);
      for (const c of cells) occupied.add(c);
      placements.push(cells);
    }

    if (fleetOk && placements.length === SHIPS.length) {
      assertEveryCellBelongsToAtMostOneShip(occupied);
      return placements;
    }
  }

  throw new Error("Could not place classic fleet — try again.");
}

export let nextDealId = 1;

/** Test helper: reset monotonic deal id. */
export function resetDealIdForTests(id = 1): void {
  nextDealId = id;
}

export function shipsToModels(ships: number[][]): ShipModel[] {
  return ships.map((positions) => ({
    positions,
    hits: 0,
    size: positions.length,
  }));
}

export function placePlayerShips(): ShipModel[] {
  return shipsToModels(generateRandomFleet());
}

export function placeAiShips(): ShipModel[] {
  return shipsToModels(generateRandomFleet());
}

export function placeShips(): {
  playerShips: ShipModel[];
  aiShips: ShipModel[];
} {
  return {
    playerShips: placePlayerShips(),
    aiShips: placeAiShips(),
  };
}

export function createBattleState(difficulty: Difficulty): BattleGameState {
  const { playerShips, aiShips } = placeShips();
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

export function isFleetSunk(ships: ShipModel[]): boolean {
  return ships.every((ship) => ship.hits === ship.size);
}

export function fleetOccupiedCells(ships: ShipModel[]): Set<number> {
  const s = new Set<number>();
  for (const sh of ships) {
    for (const c of sh.positions) s.add(c);
  }
  return s;
}

export function incrementShipHitForCell(ships: ShipModel[], cell: number): ShipModel[] {
  return ships.map((sh) =>
    sh.positions.includes(cell) ? { ...sh, hits: sh.hits + 1 } : sh,
  );
}

/** True when this hit is the last uncovered cell of that ship. */
export function isSinkingHitForCell(ships: ShipModel[], cell: number): boolean {
  return ships.some(
    (sh) => sh.positions.includes(cell) && sh.hits === sh.size - 1,
  );
}

export function checkWin(
  playerShips: ShipModel[],
  aiShips: ShipModel[],
): "player" | "ai" | null {
  if (isFleetSunk(aiShips)) return "player";
  if (isFleetSunk(playerShips)) return "ai";
  return null;
}

export function hasActiveHunt(game: BattleGameState): boolean {
  return game.aiShips.some((ship) => ship.hits > 0 && ship.hits < ship.size);
}

export function assistantTipForGame(game: BattleGameState): string {
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

export function applyPlayerFire(
  prev: BattleGameState,
  cellIndex: number,
): BattleGameState {
  if (
    cellIndex < 0 ||
    cellIndex >= TOTAL_CELLS ||
    prev.playerShots.has(cellIndex)
  ) {
    return prev;
  }
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

export function applyAiFire(prev: BattleGameState, cellIndex: number): BattleGameState {
  if (cellIndex < 0 || cellIndex >= TOTAL_CELLS || prev.aiShots.has(cellIndex)) {
    return prev;
  }
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

export function pickRandomUnshotCell(shots: Set<number>): number {
  const avail: number[] = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    if (!shots.has(i)) avail.push(i);
  }
  if (avail.length === 0) {
    throw new Error("No unshot cells left.");
  }
  return randPick(avail);
}

export type AiTargetingMode = "hunt" | "target";

/** Orthogonal step on the grid: exactly one of dr, dc is ±1 and the other is 0. */
export type AiLineDirection = { dr: number; dc: number };

/** Opponent AI: checkerboard hunt + FIFO target queue after hits. */
export type AiHuntTargetBrain = {
  mode: AiTargetingMode;
  pendingTargets: number[];
  /** Last committed hit on the player board during this chase (cleared when returning to hunt or on sink). */
  lastHitCell: number | null;
  /** After two adjacent hits, only cells on this axis stay queued; extensions go forward then backward along the line. */
  lineDirection: AiLineDirection | null;
};

export function createAiHuntTargetBrain(): AiHuntTargetBrain {
  return {
    mode: "hunt",
    pendingTargets: [],
    lastHitCell: null,
    lineDirection: null,
  };
}

function clearAiTargetLine(brain: AiHuntTargetBrain): void {
  brain.lastHitCell = null;
  brain.lineDirection = null;
}

function orthoAdjacentCells(a: number, b: number): boolean {
  const A = cellRowCol(a);
  const B = cellRowCol(b);
  return Math.abs(A.row - B.row) + Math.abs(A.col - B.col) === 1;
}

function directionFromTo(fromCell: number, toCell: number): AiLineDirection | null {
  if (!orthoAdjacentCells(fromCell, toCell)) return null;
  const A = cellRowCol(fromCell);
  const B = cellRowCol(toCell);
  return { dr: Math.sign(B.row - A.row), dc: Math.sign(B.col - A.col) };
}

function cellOnOrthoLine(hitCell: number, dir: AiLineDirection, c: number): boolean {
  const H = cellRowCol(hitCell);
  const C = cellRowCol(c);
  if (dir.dc === 0 && dir.dr !== 0) return C.col === H.col;
  if (dir.dr === 0 && dir.dc !== 0) return C.row === H.row;
  return false;
}

function enqueueAlongLockedLine(
  brain: AiHuntTargetBrain,
  cell: number,
  dir: AiLineDirection,
  aiShotsAfter: Set<number>,
): void {
  const forward = cell + dir.dr * BOARD_SIZE + dir.dc;
  const backward = cell - dir.dr * BOARD_SIZE - dir.dc;
  for (const n of [forward, backward]) {
    if (n < 0 || n >= TOTAL_CELLS) continue;
    if (!orthoAdjacentCells(cell, n)) continue;
    if (aiShotsAfter.has(n)) continue;
    if (brain.pendingTargets.includes(n)) continue;
    brain.pendingTargets.push(n);
  }
}

function orthogonalNeighborCells(cell: number): number[] {
  const { row, col } = cellRowCol(cell);
  const out: number[] = [];
  if (row > 0) out.push(cell - BOARD_SIZE);
  if (row < BOARD_SIZE - 1) out.push(cell + BOARD_SIZE);
  if (col > 0) out.push(cell - 1);
  if (col < BOARD_SIZE - 1) out.push(cell + 1);
  return out;
}

/**
 * Chooses the next AI shot. Mutates `brain` (use a throwaway copy if the turn may be cancelled).
 * Target mode: FIFO from `pendingTargets` (skips already-shot indices). Hunt mode: random unshot
 * checkerboard cell, preferring (row+col) even parity then odd, then any remaining.
 */
export function pickHuntTargetAiCell(
  aiShots: Set<number>,
  brain: AiHuntTargetBrain,
): number {
  while (brain.mode === "target" && brain.pendingTargets.length > 0) {
    const next = brain.pendingTargets[0]!;
    if (aiShots.has(next)) {
      brain.pendingTargets.shift();
      continue;
    }
    brain.pendingTargets.shift();
    return next;
  }

  brain.pendingTargets = [];
  brain.mode = "hunt";
  clearAiTargetLine(brain);

  const evenParity: number[] = [];
  const oddParity: number[] = [];
  for (let i = 0; i < TOTAL_CELLS; i++) {
    if (aiShots.has(i)) continue;
    const { row, col } = cellRowCol(i);
    if ((row + col) % 2 === 0) evenParity.push(i);
    else oddParity.push(i);
  }
  const primary = evenParity.length > 0 ? evenParity : oddParity;
  if (primary.length > 0) {
    return randPick(primary);
  }
  return pickRandomUnshotCell(aiShots);
}

/**
 * After a committed AI shot: on hit, switch to target and enqueue neighbors (all four until
 * two adjacent hits lock an axis, then only that line — forward along the hit streak first).
 * On sink, clears the chase and returns to hunt. On miss, return to hunt if the queue is empty.
 */
export function registerAiShotResult(
  brain: AiHuntTargetBrain,
  cell: number,
  hit: boolean,
  aiShotsAfter: Set<number>,
  opts?: { sunk?: boolean },
): void {
  if (hit && opts?.sunk) {
    brain.mode = "hunt";
    brain.pendingTargets = [];
    clearAiTargetLine(brain);
    return;
  }

  if (hit) {
    brain.mode = "target";
    const prevHit = brain.lastHitCell;
    if (prevHit !== null && orthoAdjacentCells(prevHit, cell)) {
      const dir = directionFromTo(prevHit, cell);
      if (dir) brain.lineDirection = dir;
    } else {
      brain.lineDirection = null;
    }

    if (brain.lineDirection) {
      const dir = brain.lineDirection;
      brain.pendingTargets = brain.pendingTargets.filter(
        (c) => !aiShotsAfter.has(c) && cellOnOrthoLine(cell, dir, c),
      );
      enqueueAlongLockedLine(brain, cell, dir, aiShotsAfter);
    } else {
      for (const n of orthogonalNeighborCells(cell)) {
        if (aiShotsAfter.has(n)) continue;
        if (brain.pendingTargets.includes(n)) continue;
        brain.pendingTargets.push(n);
      }
    }
    brain.lastHitCell = cell;
  } else if (brain.pendingTargets.length === 0) {
    brain.mode = "hunt";
    clearAiTargetLine(brain);
  }
}

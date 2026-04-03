import { describe, expect, it, beforeEach } from "vitest";

import type { BattleGameState } from "./battleship";
import {
  applyAiFire,
  applyPlayerFire,
  assertShipCellsAreStraightLineNoWrap,
  assertValidFleetLayout,
  BOARD_SIZE,
  cellRowCol,
  cellTouchesFleet,
  checkWin,
  createAiHuntTargetBrain,
  EXPECTED_SHIP_CELL_COUNT,
  generateRandomFleet,
  hasActiveHunt,
  incrementShipHitForCell,
  isFleetSunk,
  isSinkingHitForCell,
  mirroredCurrentTurn,
  pickHuntTargetAiCell,
  pickRandomUnshotCell,
  registerAiShotResult,
  resetDealIdForTests,
  SHIPS,
  TOTAL_CELLS,
} from "./battleship";

describe("cellRowCol", () => {
  it("maps linear index to row/col on 10x10", () => {
    expect(cellRowCol(0)).toEqual({ row: 0, col: 0 });
    expect(cellRowCol(9)).toEqual({ row: 0, col: 9 });
    expect(cellRowCol(10)).toEqual({ row: 1, col: 0 });
    expect(cellRowCol(99)).toEqual({ row: 9, col: 9 });
  });
});

describe("cellTouchesFleet", () => {
  it("returns true when cell is in the fleet", () => {
    expect(cellTouchesFleet(5, new Set([5]))).toBe(true);
  });

  it("returns true for orthogonal neighbors", () => {
    expect(cellTouchesFleet(1, new Set([0]))).toBe(true);
    expect(cellTouchesFleet(11, new Set([10]))).toBe(true);
  });

  it("returns true for diagonal neighbors (king-adjacent)", () => {
    expect(cellTouchesFleet(11, new Set([0]))).toBe(true);
  });

  it("returns false when separated by at least one cell (Chebyshev >= 2)", () => {
    expect(cellTouchesFleet(2, new Set([0]))).toBe(false);
    expect(cellTouchesFleet(20, new Set([0]))).toBe(false);
  });
});

describe("assertShipCellsAreStraightLineNoWrap", () => {
  it("accepts valid horizontal and vertical segments", () => {
    expect(() => assertShipCellsAreStraightLineNoWrap([0, 1, 2])).not.toThrow();
    expect(() => assertShipCellsAreStraightLineNoWrap([0, 10, 20])).not.toThrow();
  });

  it("rejects out of bounds", () => {
    expect(() => assertShipCellsAreStraightLineNoWrap([-1])).toThrow();
    expect(() => assertShipCellsAreStraightLineNoWrap([TOTAL_CELLS])).toThrow();
  });

  it("rejects same-column leap from top row to bottom row (every column)", () => {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const top = col;
      const bottom = (BOARD_SIZE - 1) * BOARD_SIZE + col;
      expect(() => assertShipCellsAreStraightLineNoWrap([top, bottom])).toThrow(/no edge wrap/);
    }
  });

  it("rejects wrap at north-west corner (index 0)", () => {
    // Row 0: cannot span col 0 to col 9 without intermediate cells.
    expect(() => assertShipCellsAreStraightLineNoWrap([0, 9])).toThrow(/no edge wrap/);
  });

  it("rejects wrap at north-east corner (index 9)", () => {
    // Linear index +1 crosses into the next row (not a horizontal continuation on row 0).
    expect(() => assertShipCellsAreStraightLineNoWrap([9, 10])).toThrow(/Invalid ship/);
  });

  it("rejects wrap at south-west corner (index 90)", () => {
    // Row 9: cannot span col 0 to col 9 without intermediate cells.
    expect(() => assertShipCellsAreStraightLineNoWrap([90, 99])).toThrow(/no edge wrap/);
  });

  it("rejects wrap at south-east corner (index 99)", () => {
    // Row 9: gap before the corner (missing col 8).
    expect(() => assertShipCellsAreStraightLineNoWrap([97, 99])).toThrow(/no edge wrap/);
    // Column 9: gap below row 6 (missing rows 7–8 on that column).
    expect(() => assertShipCellsAreStraightLineNoWrap([69, 99])).toThrow(/no edge wrap/);
  });

  it("rejects diagonal ships (not axis-aligned)", () => {
    const diagonalMsg = /straight horizontal or vertical|diagonal/;
    // Bishop-adjacent pairs (different row and column).
    expect(() => assertShipCellsAreStraightLineNoWrap([0, 11])).toThrow(diagonalMsg);
    expect(() => assertShipCellsAreStraightLineNoWrap([10, 21])).toThrow(diagonalMsg);
    expect(() => assertShipCellsAreStraightLineNoWrap([9, 18])).toThrow(diagonalMsg);
    expect(() => assertShipCellsAreStraightLineNoWrap([90, 81])).toThrow(diagonalMsg);
    // Opposite corners: not a horizontal or vertical segment.
    expect(() => assertShipCellsAreStraightLineNoWrap([0, 99])).toThrow(diagonalMsg);
    // Three cells stepping down-diagonal in row/col.
    expect(() => assertShipCellsAreStraightLineNoWrap([0, 11, 22])).toThrow(diagonalMsg);
  });
});

describe("assertValidFleetLayout", () => {
  it("accepts a spaced classic fleet (no touch between ships)", () => {
    const fleet = [
      [0, 1, 2, 3, 4],
      [60, 61, 62, 63],
      [9, 19, 29],
      [80, 81, 82],
      [44, 45],
    ];
    expect(() => assertValidFleetLayout(fleet)).not.toThrow();
  });

  it("rejects touching ships", () => {
    const fleet = [
      [0, 1, 2, 3, 4],
      [5, 6, 7, 8],
      [20, 30, 40],
      [60, 70, 80],
      [95, 96],
    ];
    expect(() => assertValidFleetLayout(fleet)).toThrow(/touches/);
  });

  it("rejects wrong ship count", () => {
    expect(() => assertValidFleetLayout([[0, 1]])).toThrow();
  });

  it("rejects ships that skip cells (no bottom-row or column wrap)", () => {
    const fleet = [
      [0, 1, 2, 3, 4],
      [60, 61, 62, 63],
      [20, 21, 22],
      [40, 41, 42],
      [90, 99],
    ];
    expect(() => assertValidFleetLayout(fleet)).toThrow(/no edge wrap/);
  });
});

describe("generateRandomFleet", () => {
  it("produces a valid fleet repeatedly", () => {
    for (let i = 0; i < 40; i++) {
      const fleet = generateRandomFleet();
      expect(fleet.length).toBe(SHIPS.length);
      expect(() => assertValidFleetLayout(fleet)).not.toThrow();
      const cells = new Set(fleet.flat());
      expect(cells.size).toBe(EXPECTED_SHIP_CELL_COUNT);
    }
  });
});

describe("mirroredCurrentTurn", () => {
  it("tracks phase and winner", () => {
    expect(mirroredCurrentTurn("setup", null)).toBe("player");
    expect(mirroredCurrentTurn("playerTurn", null)).toBe("player");
    expect(mirroredCurrentTurn("aiTurn", null)).toBe("ai");
    expect(mirroredCurrentTurn("gameOver", "player")).toBe("player");
    expect(mirroredCurrentTurn("gameOver", "ai")).toBe("ai");
  });
});

describe("applyPlayerFire / applyAiFire", () => {
  const base = (): Parameters<typeof applyPlayerFire>[0] => ({
    dealId: 1,
    difficulty: "medium",
    gamePhase: "playerTurn",
    currentTurn: "player",
    playerShips: [{ positions: [0], hits: 0, size: 1 }],
    aiShips: [{ positions: [50], hits: 0, size: 1 }],
    playerShots: new Set(),
    aiShots: new Set(),
    status: "",
    consecutiveMisses: 0,
    lastOpponentBoardCell: null,
    lastPlayerBoardCell: null,
    lastOutcome: "ready",
    winner: null,
    playerFireEnabled: true,
  });

  it("ignores duplicate / out-of-range player shots", () => {
    const g = base();
    const once = applyPlayerFire(g, 99);
    expect(once.playerShots.has(99)).toBe(true);
    expect(applyPlayerFire(once, 99)).toBe(once);
    expect(applyPlayerFire(g, -1)).toBe(g);
    expect(applyPlayerFire(g, TOTAL_CELLS)).toBe(g);
  });

  it("player miss hands off to aiTurn", () => {
    const g = base();
    const next = applyPlayerFire(g, 0);
    expect(next.gamePhase).toBe("aiTurn");
    expect(next.lastOutcome).toBe("miss");
    expect(next.consecutiveMisses).toBe(1);
  });

  it("player hit on last cell wins", () => {
    const g = base();
    const next = applyPlayerFire(g, 50);
    expect(next.gamePhase).toBe("gameOver");
    expect(next.winner).toBe("player");
    expect(next.aiShips[0]!.hits).toBe(1);
  });

  it("ai duplicate shot is no-op", () => {
    const g = base();
    const after = applyAiFire(g, 0);
    expect(applyAiFire(after, 0)).toBe(after);
  });

  it("ai hit damages player ship and hands back to player turn", () => {
    const g: ReturnType<typeof base> = {
      ...base(),
      playerShips: [{ positions: [0, 10], hits: 0, size: 2 }],
    };
    const next = applyAiFire(g, 0);
    expect(next.playerShips[0]!.hits).toBe(1);
    expect(next.gamePhase).toBe("playerTurn");
    expect(next.lastOutcome).toBe("hit");
    expect(next.aiShots.has(0)).toBe(true);
  });

  it("ai miss records shot and hands back to player turn", () => {
    const g: ReturnType<typeof base> = {
      ...base(),
      playerShips: [{ positions: [0, 10], hits: 0, size: 2 }],
    };
    const next = applyAiFire(g, 99);
    expect(next.gamePhase).toBe("playerTurn");
    expect(next.lastOutcome).toBe("miss");
    expect(next.aiShots.has(99)).toBe(true);
    expect(next.playerShips[0]!.hits).toBe(0);
  });
});

describe("incrementShipHitForCell / isSinkingHitForCell / isFleetSunk", () => {
  it("detects sinking shot and fleet sunk", () => {
    const ships = [{ positions: [1, 2], hits: 0, size: 2 }];
    expect(isSinkingHitForCell(ships, 1)).toBe(false);
    expect(isSinkingHitForCell(ships, 2)).toBe(false);
    const after1 = incrementShipHitForCell(ships, 1);
    expect(isSinkingHitForCell(after1, 2)).toBe(true);
    const after2 = incrementShipHitForCell(after1, 2);
    expect(isFleetSunk(after2)).toBe(true);
  });
});

describe("createAiHuntTargetBrain", () => {
  it("starts in hunt mode with an empty queue", () => {
    const b = createAiHuntTargetBrain();
    expect(b.mode).toBe("hunt");
    expect(b.pendingTargets).toEqual([]);
    expect(b.lastHitCell).toBe(null);
    expect(b.lineDirection).toBe(null);
  });
});

describe("checkWin", () => {
  it("returns null when both fleets float", () => {
    const player = [{ positions: [0], hits: 0, size: 1 }];
    const ai = [{ positions: [50], hits: 0, size: 1 }];
    expect(checkWin(player, ai)).toBe(null);
  });

  it("returns player when ai fleet is sunk", () => {
    const player = [{ positions: [0], hits: 0, size: 1 }];
    const ai = [{ positions: [50], hits: 1, size: 1 }];
    expect(checkWin(player, ai)).toBe("player");
  });

  it("returns ai when player fleet is sunk", () => {
    const player = [{ positions: [0], hits: 1, size: 1 }];
    const ai = [{ positions: [50], hits: 0, size: 1 }];
    expect(checkWin(player, ai)).toBe("ai");
  });
});

describe("hasActiveHunt", () => {
  const miniGame = () =>
    ({
      dealId: 1,
      difficulty: "medium" as const,
      gamePhase: "playerTurn" as const,
      currentTurn: "player" as const,
      playerShips: [{ positions: [0], hits: 0, size: 1 }],
      aiShips: [
        { positions: [50, 51], hits: 1, size: 2 },
      ],
      playerShots: new Set<number>(),
      aiShots: new Set<number>(),
      status: "",
      consecutiveMisses: 0,
      lastOpponentBoardCell: null,
      lastPlayerBoardCell: null,
      lastOutcome: "ready" as const,
      winner: null,
      playerFireEnabled: true,
    }) satisfies BattleGameState;

  it("is true when an ai ship is damaged but not sunk", () => {
    expect(hasActiveHunt(miniGame())).toBe(true);
  });

  it("is false when no ai ship has a partial hit", () => {
    const g = miniGame();
    g.aiShips = [{ positions: [50, 51], hits: 0, size: 2 }];
    expect(hasActiveHunt(g)).toBe(false);
  });

  it("is false when all damaged ai ships are fully sunk", () => {
    const g = miniGame();
    g.aiShips = [{ positions: [50, 51], hits: 2, size: 2 }];
    expect(hasActiveHunt(g)).toBe(false);
  });
});

describe("pickHuntTargetAiCell / registerAiShotResult", () => {
  it("hunt mode uses only checkerboard parity until that parity is exhausted", () => {
    const shots = new Set<number>();
    const brain = createAiHuntTargetBrain();
    for (let n = 0; n < 50; n++) {
      const cell = pickHuntTargetAiCell(shots, brain);
      const { row, col } = cellRowCol(cell);
      expect((row + col) % 2).toBe(0);
      expect(shots.has(cell)).toBe(false);
      shots.add(cell);
      const after = new Set(shots);
      registerAiShotResult(brain, cell, false, after);
    }
    const cell51 = pickHuntTargetAiCell(shots, brain);
    const rc = cellRowCol(cell51);
    expect((rc.row + rc.col) % 2).toBe(1);
  });

  it("target mode follows FIFO and enqueues orthogonal neighbors on hit", () => {
    const shots = new Set<number>();
    const brain = createAiHuntTargetBrain();
    const first = pickHuntTargetAiCell(shots, brain);
    shots.add(first);
    registerAiShotResult(brain, first, true, new Set(shots));
    expect(brain.mode).toBe("target");
    expect(brain.pendingTargets.length).toBeGreaterThan(0);

    const nextQueued = brain.pendingTargets[0]!;
    const second = pickHuntTargetAiCell(shots, brain);
    expect(second).toBe(nextQueued);
    expect(shots.has(second)).toBe(false);
  });

  it("after two collinear hits, drops perpendicular queue and extends along the line first", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 0, true, new Set([0]));
    expect(brain.lineDirection).toBe(null);
    expect(brain.pendingTargets).toContain(10);
    expect(brain.pendingTargets).toContain(1);

    registerAiShotResult(brain, 10, true, new Set([0, 10]));
    expect(brain.lineDirection).toEqual({ dr: 1, dc: 0 });
    expect(brain.pendingTargets).not.toContain(1);
    expect(brain.pendingTargets[0]).toBe(20);
  });

  it("line lock at bottom edge: never enqueues forward off-board; still probes north along column", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 89, true, new Set([89]));
    registerAiShotResult(brain, 99, true, new Set([89, 99]));
    expect(brain.lineDirection).toEqual({ dr: 1, dc: 0 });
    expect(brain.pendingTargets).toEqual([79]);
    expect(brain.pendingTargets.every((c) => c >= 0 && c < TOTAL_CELLS)).toBe(true);
    expect(brain.lastHitCell).toBe(99);
    expect(brain.mode).toBe("target");
  });

  it("line lock at top edge: never enqueues forward off-board; still probes south along column", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 10, true, new Set([10]));
    registerAiShotResult(brain, 0, true, new Set([10, 0]));
    expect(brain.lineDirection).toEqual({ dr: -1, dc: 0 });
    expect(brain.pendingTargets).toEqual([20]);
    expect(brain.lastHitCell).toBe(0);
  });

  it("line lock at east edge: never enqueues forward off-board; still probes west along row", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 98, true, new Set([98]));
    registerAiShotResult(brain, 99, true, new Set([98, 99]));
    expect(brain.lineDirection).toEqual({ dr: 0, dc: 1 });
    expect(brain.pendingTargets).toEqual([97]);
    expect(brain.lastHitCell).toBe(99);
  });

  it("line lock at west edge (col 0): does not wrap to previous row; only true row neighbors enqueue", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 11, true, new Set([11]));
    registerAiShotResult(brain, 10, true, new Set([11, 10]));
    expect(brain.lineDirection).toEqual({ dr: 0, dc: -1 });
    expect(brain.pendingTargets).toEqual([12]);
    expect(
      brain.pendingTargets.every((c) => cellRowCol(c).row === 1),
    ).toBe(true);
  });

  it("sunk hit clears target queue, line lock, and returns to hunt", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 0, true, new Set([0]));
    registerAiShotResult(brain, 10, true, new Set([0, 10]));
    expect(brain.lineDirection).not.toBe(null);
    expect(brain.pendingTargets.length).toBeGreaterThan(0);
    registerAiShotResult(brain, 20, true, new Set([0, 10, 20]), { sunk: true });
    expect(brain.mode).toBe("hunt");
    expect(brain.pendingTargets).toEqual([]);
    expect(brain.lastHitCell).toBe(null);
    expect(brain.lineDirection).toBe(null);
  });

  it("hit not orthogonally adjacent to lastHitCell clears line lock and enqueues new hit neighbors", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 0, true, new Set([0]));
    registerAiShotResult(brain, 50, true, new Set([0, 50]));
    expect(brain.lineDirection).toBe(null);
    expect(brain.lastHitCell).toBe(50);
    // Cell 50 is row 5 col 0: orthogonal neighbors 40, 60, 51 (west is out of bounds).
    expect(brain.pendingTargets).toEqual(
      expect.arrayContaining([40, 51, 60]),
    );
  });

  it("exhausting target queue via pick then falling through clears line state for hunt", () => {
    const brain: ReturnType<typeof createAiHuntTargetBrain> = {
      mode: "target",
      pendingTargets: [7],
      lastHitCell: 0,
      lineDirection: { dr: 1, dc: 0 },
    };
    const shots = new Set<number>();
    expect(pickHuntTargetAiCell(shots, brain)).toBe(7);
    expect(brain.mode).toBe("target");
    expect(brain.pendingTargets).toEqual([]);
    shots.add(7);
    pickHuntTargetAiCell(shots, brain);
    expect(brain.mode).toBe("hunt");
    expect(brain.lastHitCell).toBe(null);
    expect(brain.lineDirection).toBe(null);
  });

  it("miss draining last target clears line state, not only mode", () => {
    const shots = new Set<number>();
    const brain: ReturnType<typeof createAiHuntTargetBrain> = {
      mode: "target",
      pendingTargets: [5],
      lastHitCell: 22,
      lineDirection: { dr: 0, dc: 1 },
    };
    expect(pickHuntTargetAiCell(shots, brain)).toBe(5);
    shots.add(5);
    registerAiShotResult(brain, 5, false, shots);
    expect(brain.mode).toBe("hunt");
    expect(brain.lastHitCell).toBe(null);
    expect(brain.lineDirection).toBe(null);
  });

  it("returns to hunt when target queue is empty after a miss", () => {
    const shots = new Set<number>();
    const brain: ReturnType<typeof createAiHuntTargetBrain> = {
      mode: "target",
      pendingTargets: [5],
      lastHitCell: null,
      lineDirection: null,
    };
    const cell = pickHuntTargetAiCell(shots, brain);
    expect(cell).toBe(5);
    shots.add(cell);
    registerAiShotResult(brain, cell, false, new Set(shots));
    expect(brain.mode).toBe("hunt");
    expect(brain.pendingTargets.length).toBe(0);
  });

  it("skips already-shot indices at the head of the target queue", () => {
    const shots = new Set<number>([5]);
    const brain: ReturnType<typeof createAiHuntTargetBrain> = {
      mode: "target",
      pendingTargets: [5, 11],
      lastHitCell: null,
      lineDirection: null,
    };
    const cell = pickHuntTargetAiCell(shots, brain);
    expect(cell).toBe(11);
    expect(shots.has(11)).toBe(false);
  });

  it("hit at a corner enqueues only in-bounds orthogonal neighbors", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 0, true, new Set([0]));
    const uniq = new Set(brain.pendingTargets);
    expect(uniq.size).toBe(2);
    expect(uniq.has(1)).toBe(true);
    expect(uniq.has(10)).toBe(true);
  });

  it("hit does not enqueue neighbors that are already shot", () => {
    const brain = createAiHuntTargetBrain();
    registerAiShotResult(brain, 0, true, new Set([0, 1, 10]));
    expect(brain.pendingTargets).toEqual([]);
  });

  it("hit does not duplicate a cell already in the queue", () => {
    const brain = createAiHuntTargetBrain();
    brain.pendingTargets = [10];
    registerAiShotResult(brain, 0, true, new Set([0]));
    expect(brain.pendingTargets.filter((c) => c === 10).length).toBe(1);
  });

  it("miss leaves target mode when the queue still has cells", () => {
    const brain: ReturnType<typeof createAiHuntTargetBrain> = {
      mode: "target",
      pendingTargets: [20, 30],
      lastHitCell: null,
      lineDirection: null,
    };
    registerAiShotResult(brain, 99, false, new Set([99]));
    expect(brain.mode).toBe("target");
    expect(brain.pendingTargets).toEqual([20, 30]);
  });

  it("throws when every cell is already shot", () => {
    const shots = new Set<number>();
    for (let i = 0; i < TOTAL_CELLS; i++) shots.add(i);
    const brain = createAiHuntTargetBrain();
    expect(() => pickHuntTargetAiCell(shots, brain)).toThrow(/No unshot cells/);
  });
});

describe("pickRandomUnshotCell", () => {
  it("returns an unshot index", () => {
    const shots = new Set<number>([0, 2, 4]);
    const c = pickRandomUnshotCell(shots);
    expect(shots.has(c)).toBe(false);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThan(TOTAL_CELLS);
  });

  it("throws when board is full", () => {
    const all = new Set<number>();
    for (let i = 0; i < TOTAL_CELLS; i++) all.add(i);
    expect(() => pickRandomUnshotCell(all)).toThrow(/No unshot cells/);
  });
});

describe("constants", () => {
  it("classic fleet sums to 17 cells", () => {
    expect(SHIPS.reduce((s, x) => s + x.size, 0)).toBe(17);
    expect(BOARD_SIZE).toBe(10);
    expect(TOTAL_CELLS).toBe(100);
  });
});

beforeEach(() => {
  resetDealIdForTests(1);
});

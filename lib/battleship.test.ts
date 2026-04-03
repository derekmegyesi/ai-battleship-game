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

  it("rejects row wrap (last col to first col same row)", () => {
    expect(() => assertShipCellsAreStraightLineNoWrap([9, 10])).toThrow();
  });

  it("rejects diagonal polyline", () => {
    expect(() => assertShipCellsAreStraightLineNoWrap([0, 11])).toThrow();
  });

  it("rejects out of bounds", () => {
    expect(() => assertShipCellsAreStraightLineNoWrap([-1])).toThrow();
    expect(() => assertShipCellsAreStraightLineNoWrap([TOTAL_CELLS])).toThrow();
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

  it("returns to hunt when target queue is empty after a miss", () => {
    const shots = new Set<number>();
    const brain: ReturnType<typeof createAiHuntTargetBrain> = {
      mode: "target",
      pendingTargets: [5],
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

# Battleship: Solo Tactical

A modern, single-player Battleship experience focused on fast gameplay, clear feedback loops, and a foundation for AI-driven system evolution.

---

## Overview

This project started as a simple question:

What does a well-scoped, polished game look like when built using AI-assisted development tools?

Rather than overbuilding, I focused on a tight core:
- small grid
- simple rules
- strong visual feedback
- fast iteration

The result is a replayable game that emphasizes decision-making under constraints.

---

## Gameplay

- 6x6 grid
- Two hidden ships (length 3 and 2)
- Limited number of shots per game
- Immediate feedback on each move (hit or miss)
- Win and loss conditions
- Reset to replay

The shot limit introduces tension and forces more deliberate play, moving the experience beyond simple exploration.

---

## Product Approach

The initial version was a deterministic system where the user would eventually win.

To improve engagement, I introduced:
- constraints (limited shots)
- clear feedback loops
- a tighter interaction model

This shifts the experience toward:
> making informed decisions rather than randomly clicking

The scope was intentionally constrained to ensure a complete, polished experience before adding complexity.

---

## System Evolution

This project is designed to evolve incrementally.

Planned extensions include:
- pattern-based ship placement (beyond pure randomness)
- difficulty modes
- adaptive behavior based on player performance
- AI-assisted feedback and strategy hints

Longer term, the goal is to explore agent-based systems that influence gameplay and difficulty.

---

## Tech Stack

- Next.js (React)
- Tailwind CSS
- Cursor (AI-assisted development)
- Claude (reasoning and system design support)

---

## Development Approach

This project was built using an AI-assisted workflow:

- Cursor was used to generate and iterate on code
- Changes were applied incrementally (UI → logic → refinement)
- Claude was used selectively to reason through logic and structure

The focus was on maintaining control of the system while using AI to accelerate execution.

---

## Next Steps

- Introduce difficulty levels
- Improve ship placement logic
- Add lightweight AI-driven feedback
- Continue refining interaction and visual polish

---

## Running Locally

```bash
npm install
npm run dev

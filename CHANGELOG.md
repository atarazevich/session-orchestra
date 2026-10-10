# Changelog

## 0.2.0 — 2026-10-10

- **Agents.** The subagents this chat spawns show beside its sessions. Each one gets a `⟡` card in the shared grid: its type, running or done, its model, its task, and the tokens and time it took. Its prompt and its result are lines in Messages, and you read them in full like any message.
- **`[ ⟡ agents ]` switch** on the Messages line. It hides or shows all agent cards and lines. It is on by default and remembered per session.
- Agents never count as sessions.
- The "no longer running" list on the Sessions line is gone. Messages from closed sessions stay in the list.

## 0.1.2 — 2026-10-07

- More reliable loading. Earlier messages never arrive late, and "Reading…" never gets stuck. Turning the pane off, or running the demo, wins over a load still in progress.
- The README's "What it runs and what it hooks" section matches the code. There is an upgrade note for the rename.

## 0.1.1 — 2026-10-07

- The pane fills from the current transcript first. It says "Reading…" while earlier transcripts load, instead of showing zeros.

## 0.1.0 — 2026-10-06

- First release, as `orchestra`, later renamed `session-orchestra`. A side pane with the sessions this chat talks to, every message between them, and a reader for the message you pick.

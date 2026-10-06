# session-orchestra

**A Claude Code plugin that shows the messages your Claude Code sessions send each other, in a side pane.**

When one session hands work to others (a lead and its teams, a planner and its workers), they talk through `SendMessage`. Those messages end up scattered through each session's transcript. Orchestra reads them back and draws them in one place: which sessions this chat talks to, how each is doing, every message between them, and the one you pick, in full.

![orchestra: sessions, messages and the picked message](docs/demo.png)

## What it is, and what it is not

Orchestra is **a view, and only a view**:

- It **reads** files Claude Code already writes on your machine: the transcripts and Claude Code's list of running sessions.
- It **does not send, change or delete** anything. It is not a messaging channel and adds none: your sessions talk exactly as they did before, through `SendMessage`.
- It **makes no network calls**.
- The only thing it keeps is whether it is on in a session, and which page of cards you were on.

## The pane

### Sessions

![Sessions](docs/sessions.png)

One card for each session this chat has messaged or heard from, the most recent first:

- the session's name, and whether it is **working** or **idle**;
- its model, its effort (`▂` low to `▂▄▆█` max) and its folder;
- its context window in use, as a bar marked at 40 %; past 40 % the card says `dumb`.

Six cards to a page (`‹ 1 2 ›`). Sessions that are no longer running are named at the right end of the Sessions line. **Click a session's name** to show only its messages; click it again, or `[ all ]`, to show every one.

### Messages

![Messages](docs/messages.png)

Every message between you, this chat and those sessions, one line each: time, sender → receiver, the start of the text. A dotted row opens each day. The wheel scrolls the list; `[ ↓ 12 newer ]` jumps back to the newest. **Click a line** to read it.

### Message

![Message](docs/message.png)

The message you clicked, or the newest one, in full, with `**bold**` and `` `code` `` drawn. The wheel scrolls a long one; `[ copy ]` puts it on the clipboard.

The sessions stay where they are while the two lists scroll.

### When the pane is closed

![The note on the hint line](docs/hint.png)

![The note under the pointer](docs/hint-hover.png)

The dim hint line under the prompt ends with a note, next to Claude Code's own (`← 5 agents`): `◆ 4 sessions ⇄ 41`, the sessions this chat talks to and the messages between them. **Click it** to open the pane. In a session where orchestra is off, the note appears once this chat messages another session or hears from one; a click turns orchestra on there. Nothing pops up.

## Install

```sh
claude plugin marketplace add atarazevich/session-orchestra
claude plugin install session-orchestra@session-orchestra
```

Sessions already open pick it up after `/reload-plugins`.

## Use

In the session whose conversations you want to see:

| Command | What it does |
|---|---|
| `/orchestra on` | Turn it on in this session. It stays on when the session resumes. |
| `/orchestra` | Open the pane again. |
| `/orchestra off` | Turn it off in this session. |
| `/orchestra on <session id>` | Show another session's conversations from this one. |
| `/orchestra demo` | Fill the pane with made-up sessions, to try it or take a screenshot. |

The pane docks as a sidebar from 144 terminal columns; at any width `/orchestra` opens it.

## Where each thing comes from

| On screen | Read from |
|---|---|
| Who talks to whom, and every message | This session's transcript: its `SendMessage` calls, the messages other sessions sent it (arrived idle or mid-turn), your prompts. A compacted session is followed back through its earlier transcripts. |
| Working or idle | `~/.claude/sessions/`, Claude Code's own record of the sessions running on this machine (the one `ListAgents` reads). |
| Model, effort, context | The last reply in each session's own transcript. |

If you run your sessions in herdr, its `herdr agent prompt <pane> "…"` sends count as messages too.

## What it runs and what it hooks

Orchestra sends nothing anywhere. The plugin directory asks each plugin to list the programs it starts and the events it hooks, so here they are.

**Programs** it starts, each by name and with no shell:

| Program | Why |
|---|---|
| `tail -c +<offset> <transcript>` | Reads a transcript from where it last stopped. The plugin API keeps only the first 4 MiB of a program's output, so a long transcript takes several reads. |
| `head -c 400000 <transcript>` | Reads the start of a transcript to find the earlier transcript a compacted session continues. |
| `tail -c <bytes> <transcript>` | Reads the end of a transcript: another session's model, effort and context, or this chat's latest messages while it is off. |
| `find ~/.claude/projects -maxdepth 2 -name <session id>.jsonl` | Finds a session's transcript. |
| `herdr agent list` | Only if herdr is installed: gets pane names, so herdr sends show the session's name. |

**Events it hooks**, every one passed on unchanged:

- `SendMessage` tool calls: it reads the recipient's name to count the conversation, and the call runs as before.
- Submitted prompts: for a message from another session, it reads the sender's name. The prompt is not changed.
- Its own pane: draw, scroll and close. The hint line under the prompt: it adds the clickable note.

It adds one command, `/orchestra` (the plugin is session-orchestra; the command keeps the short name). It runs no slash commands, submits no prompts, and makes no network or MCP calls.

## Requirements and limits

- Claude Code **2.1.289** or newer, in a terminal. It is built on Claude Code's plugin API for function hooks, which is early access and may change between releases.
- It reads Claude Code's transcript format, which is not a public interface; a release can change it. Tested on 2.1.289.
- Context % is computed from the last reply's tokens and the model's window (1M; 200k for Haiku and 4.x models). In testing it matched the status line, but it is not the number Claude Code itself reports.
- Sessions on this machine only.

## Development

```sh
claude plugin validate plugins/session-orchestra
```

Run Claude Code with `--plugin-dir plugins/session-orchestra` to try changes: the folder is watched and reloads on save.

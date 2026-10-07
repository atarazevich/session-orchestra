# Privacy

session-orchestra is a Claude Code plugin that runs only on your computer.

**What it reads.** Files Claude Code already writes on your machine: the list of running sessions in `~/.claude/sessions/` and the session transcripts in `~/.claude/projects/`. The messages your sessions send each other can contain personal data, such as names or email addresses, and the plugin shows them in its pane.

**What it stores.** Only whether it is on in a session and which page of session cards you were on, in Claude Code's own plugin storage on your machine. It keeps nothing it reads.

**What it sends.** Nothing. It makes no network calls and shares no data with the author or anyone else. There is no server.

**Contact.** Open an issue at https://github.com/atarazevich/session-orchestra/issues.

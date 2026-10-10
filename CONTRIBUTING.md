# Contributing

Thanks for your interest in session-orchestra. It is a small project with one maintainer, so issues are the best place to start.

## Report a bug or ask for a feature

Open an issue: https://github.com/atarazevich/session-orchestra/issues/new/choose. For a bug, say your Claude Code version (`claude --version`), the plugin version, what you did, and what the pane showed. A screenshot of the pane helps. Remove anything private from it first: the pane shows your messages in full.

Security problems do not go in issues. See [SECURITY.md](SECURITY.md).

## Change the code

1. Open an issue first for anything larger than a typo, so we agree on the change before you write it.
2. Fork the repository and make a branch.
3. Try your change live: run Claude Code with `--plugin-dir plugins/session-orchestra`. The folder is watched and reloads on save.
4. Check it: `claude plugin validate plugins/session-orchestra`.
5. If the change is user-visible, update the README and add a line under a new version in [CHANGELOG.md](CHANGELOG.md).
6. Open a pull request against `main`. Pull requests are squash-merged, so the PR title becomes the commit message: make it say what changed.

Keep to what the plugin is: a read-only view. It must not send, change or delete anything, and it must make no network calls (see [PRIVACY.md](PRIVACY.md)).

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

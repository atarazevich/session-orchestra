# Security

To report a vulnerability in session-orchestra, use GitHub's private reporting: the **Security** tab of this repository, then **Report a vulnerability** (https://github.com/atarazevich/session-orchestra/security/advisories/new). Please do not open a public issue for it.

I will acknowledge a report within 7 days, investigate it, and say what I will do about it. Fixes ship as a new plugin version, noted in the advisory.

What the plugin can do, for judging impact: it reads Claude Code's transcripts and session list on your machine, starts four local programs by name (`tail`, `head`, `find`, `herdr`) with no shell, and makes no network calls. See the README's "What it runs and what it hooks" and [PRIVACY.md](PRIVACY.md).

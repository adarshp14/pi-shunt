# pi-shunt

Route I/O-heavy work to a cheap worker model so your main model's context stays small.

A [Pi](https://pi.dev) port of the idea behind Spotify's [shunt](https://github.com/spotify/portal-ai-plugins) plugin for Claude Code, minus the Portal dependency. The worker is **any model Pi is logged in to**: a ChatGPT subscription model, Copilot, Gemini, Fireworks, OpenRouter, Anthropic.

## Why

Most of what a coding agent does is reading, not reasoning. Reading a 3,000 line file to answer one question costs the same frontier tokens as solving a hard bug. pi-shunt blocks those reads and hands them to a cheaper model instead. The file never enters your main model's context.

Measured on a real Express monorepo, same question, same answer:

| | main model alone | main + worker |
|---|---|---|
| main model tokens | 64,387 | 12,751 |
| worker tokens | 0 | 45,123 |

80% fewer tokens on the expensive model.

## Install

```bash
pi install npm:pi-shunt
```

Then in Pi:

```
/shunt openai-codex/gpt-5.4-mini     # pick a worker (tab completes models you're logged in to)
```

Nothing is blocked until a worker is set.

## What it does

**Gate.** A `read` of a file over the line threshold (default 350) with no offset/limit is blocked, and so is a bare `cat`, `head`, `tail`, `less`, or `more` in bash. The block message points the model at `bulk_read`. Piped commands, redirects, and reads with offset/limit pass through.

**`bulk_read`** sends the files plus a question to the worker and returns a structured bullet answer.

**`code_write`** sends a spec plus reference files to the worker and writes the result to disk. Pass both the pattern file (an existing test, say) and the source it must be correct against, or the worker will invent names.

## Commands

```
/shunt                          status
/shunt <provider>/<model-id>    set the worker
/shunt lines <n>                line threshold (default 350)
/shunt off | on                 disable / enable the gate
```

Config lives in `~/.pi/agent/shunt.json`.

## What to trust

Checked against grep on real repos:

- Counts and inventories: exact.
- "Which of these has property X": roughly 90 to 95%. The worker may infer relationships from names.
- Line numbers: wrong. Never edit from them. Re-read the section with offset/limit first.
- `code_write` output: a scaffold. Typecheck or run it. With good references it passes tests; without the source file it invents identifiers.

## Known limits

- A model can still read a whole file in offset/limit chunks. The gate discourages it, it does not prevent it.
- If the worker errors, the main model falls back to chunked reads, which costs more than no gate at all. Errors are surfaced verbatim so you notice.
- Each delegation is one shot. There is no server-side session; follow-ups resend the files, which is free where it matters because they go to the worker.

## Test

```bash
PI_MAIN=openai-codex/gpt-6-astra PI_WORKER=openai-codex/gpt-5.6-luna npm test
```

Runs a real headless Pi session against a generated 600 line file and asserts the read was blocked and `bulk_read` answered.

## License

MIT

# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project purpose

CafeBot is a simple AI chatbot for a cafe. It answers customer questions
about the menu, hours, and other FAQs. It is built to be beginner-friendly
and cheap to run — favor the simplest solution that works over
"proper"/enterprise patterns.

## Architecture

```
prompts/    AI instructions (system prompt, tone/personality rules)
data/       Menu items and FAQ content the bot draws answers from
frontend/   Chat UI the customer types into
backend/    Server that connects the frontend to the AI model
.env        Secrets/config (never commit; see .env.example)
```

Flow: frontend sends the user's message to backend -> backend combines it
with `prompts/system-prompt.md` and relevant `data/*.json` content -> backend
calls the AI model -> response goes back to frontend.

Keep this flow flat. Don't introduce extra services, queues, databases, or
build tooling unless the task actually requires them.

## Coding rules

- Keep it minimal: the smallest amount of code that correctly does the task.
- No frameworks, abstractions, or config beyond what's needed right now.
- Prefer plain, readable code over clever code.
- Don't add features, error handling, or options that weren't asked for.
- Don't create new top-level folders or files outside the structure above
  without asking first.
- No comments explaining *what* code does; only note *why* when it's
  non-obvious.

## Security rules

- Never hard-code API keys, passwords, or secrets in source files — they
  belong in `.env` (untracked; see `.env.example` for the template).
- Never commit `.env` or any file containing real secrets.
- Validate/sanitize any user input before using it in prompts, file paths,
  or commands.
- Don't log full user messages or secrets to persistent logs.
- Keep the backend as the only place that holds the API key — never expose
  it to frontend code.

## Token-saving rules

- Keep the system prompt in `prompts/system-prompt.md` short and specific;
  avoid restating instructions the model doesn't need for every message.
- Send only the relevant slice of `data/*.json` (e.g. matching menu items)
  to the model, not the entire file, once data grows beyond a few entries.
- Avoid unnecessary back-and-forth or multi-step chains for simple lookups
  (e.g. FAQ answers) — answer directly from data when possible instead of
  invoking the AI model at all.

## Task scope

Only modify the files needed for the current task. Don't refactor,
reformat, or "improve" unrelated files while working.

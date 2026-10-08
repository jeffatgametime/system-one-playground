# OpenAI Decisions API

The optional **GPT-6 Luna · OpenAI Decisions** engine sends text to OpenAI's
dedicated `POST https://api.openai.com/v1/decisions` endpoint. This is **not**
Responses, Chat Completions, or an agent session. As documented October 8, 2026,
Decisions is a public beta and supports `gpt-6-luna` only.
[Official guide](https://developers.openai.com/api/docs/guides/decisions).

## Setup

1. Add `OPENAI_API_KEY=…` to the ignored `.env` at the lab root. Keep other keys,
   including `TYPESAFE_API_KEY`, on their own lines. Never put credentials in a
   preset, screenshot, or issue. Prefer file permissions `0600`.
2. Run `uv sync --project engines/openai` (or `make setup`). No model weights are
   needed. The adapter uses HTTPX; no OpenAI SDK or additional runtime is required.
3. Run `make lab`, open **Engines**, and start **GPT-6 Luna · OpenAI Decisions**.
   Select it in **Playground** and run a request.

Only this remote engine receives `OPENAI_API_KEY`; local sandboxed engines and
the Jev proxy do not. API keys are never sent to the browser. Changing `.env`
requires restarting the engine, not the gateway.

**Starting the engine makes one billable warm-up request.** Playground repeat,
benchmarks, load tests, and `make verify ENGINES_TO_VERIFY=openai` make additional
billable requests. The adapter makes no automatic retries or stronger-model
fallbacks. An HTTP timeout does not prove server-side cancellation or no charge.

## Contract translation

- String state is passed unchanged; structured state is JSON-encoded text.
- `choice` criteria become string-valued choices with descriptions.
- Ordered `score` criteria become zero-based levels. Scores are expected values,
  not a selected category or percentage.
- `noul` becomes `predicate`; the returned probability becomes `noul`.
- Non-string instructions/descriptions are JSON-encoded, not silently discarded.
- Ordered answer names, counts, types, and distribution entries are checked;
  labkit validates probabilities and recomputes comparable lab confidence.
  OpenAI's own choice/score/confidence remain under the answer's `engine` field.
- A per-question OpenAI refusal fails the whole engine result with **502**, since
  the lab has no abstention answer. It is never converted into a scored answer.

This adapter supports the lab's **text-only** contract, not image input. Returned
probabilities describe model inference; they do not authorize tool execution or
constitute verified accuracy/calibration.

## Measurement and errors

CPU and physical memory measure the **local proxy**, not OpenAI's model. Inference
latency includes network/provider time. Usage comes from the provider response;
the UI does not estimate a dollar charge.

Missing keys fail before network access. Provider 400/422 become input errors;
other provider failures become inference errors. Provider bodies are withheld to
avoid echoing secrets or private input into logs/UI. OpenAI account/model access
is verified by actual inference, not by merely displaying a ready UI.

Offline adapter tests (`cd engines/openai && uv run pytest -q`) use only
synthetic credentials and HTTPX MockTransport. CI and browser tests need no key
and must not call the paid endpoint.

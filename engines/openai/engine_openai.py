"""Translate the lab's text-only System One contract to OpenAI Decisions.

Remote inference is billable, including labkit's startup warm-up. There are no
automatic retries or model fallbacks. Refusals fail closed: the lab contract has
no abstention answer, so never turn a refusal into a false predicate or uniform
distribution. labkit validates and standardises the translated probabilities.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from labkit.contract import ContractError

MODEL = "gpt-6-luna"
ENDPOINT = "https://api.openai.com/v1/decisions"


def text(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def question(qid: str, q: dict[str, Any]) -> dict[str, Any]:
    instructions = text(q["instructions"]) if q.get("instructions") is not None else ""
    base = {"name": qid, "instructions": instructions}
    if q["type"] == "choice":
        return {**base, "type": "choice", "choices": [
            {"value": label, **({"description": text(description)} if description is not None else {})}
            for label, description in q["criteria"].items()
        ]}
    if q["type"] == "score":
        return {**base, "type": "score", "levels": [
            {"label": str(i), "description": text(level)} for i, level in enumerate(q["criteria"])
        ]}
    if q["type"] == "noul":
        if criteria := q.get("criteria"):
            base["instructions"] += "\nPredicate criteria: " + text(criteria)
        return {**base, "type": "predicate"}
    raise ValueError("OpenAI supports only choice, score, and noul questions")


def distribution(answer: dict[str, Any], kind: str) -> dict[str, Any]:
    probabilities = answer.get("probabilities")
    if not isinstance(probabilities, list):
        raise ContractError("OpenAI returned no probability distribution")
    out: dict[str, Any] = {}
    for item in probabilities:
        if not isinstance(item, dict) or "value" not in item or "probability" not in item:
            raise ContractError("OpenAI returned an invalid probability entry")
        value = item["value"]
        if kind == "choice" and not isinstance(value, str):
            raise ContractError("OpenAI returned a non-string choice value")
        if kind == "score" and (type(value) is not int or value < 0):
            raise ContractError("OpenAI returned an invalid score index")
        key = str(value)
        if key in out:
            raise ContractError("OpenAI returned duplicate probability entries")
        out[key] = item["probability"]
    return out


def translate(body: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(body, dict) or body.get("model") != MODEL:
        raise ContractError("OpenAI returned an unexpected model or response shape")
    answers = body.get("answers")
    if not isinstance(answers, list) or len(answers) != len(questions):
        raise ContractError("OpenAI returned the wrong number of answers")
    out = {}
    for (qid, q), answer in zip(questions.items(), answers):
        if not isinstance(answer, dict) or answer.get("name") != qid:
            raise ContractError("OpenAI answer names/order do not match the request")
        kind = answer.get("type")
        if kind == "refusal":
            raise ContractError(f"OpenAI refused question {qid!r}; no probabilities fabricated")
        expected = "predicate" if q["type"] == "noul" else q["type"]
        if kind != expected:
            raise ContractError("OpenAI returned the wrong answer type")
        if kind == "predicate":
            if "probability" not in answer:
                raise ContractError("OpenAI predicate is missing its probability")
            out[qid] = {"noul": answer["probability"]}
        else:
            result = {"probabilities": distribution(answer, kind)}
            # Preserve provider diagnostics; labkit derives comparable canonical
            # confidence/choice/score independently from the distribution.
            for key in (kind, "confidence"):
                if key in answer:
                    result[key] = answer[key]
            out[qid] = result
    usage = body.get("usage")
    if not isinstance(usage, dict):
        raise ContractError("OpenAI returned no usage object")
    return {"answers": out, "usage": usage}


class OpenAIPredictor:
    def __init__(self, model: str, api_key: str, client: httpx.Client | None = None):
        if model != MODEL:
            raise ValueError("The Decisions API adapter supports only gpt-6-luna")
        self.model = model
        self.client = client or httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0))
        self.headers = {"authorization": f"Bearer {api_key}"}

    def info(self) -> dict[str, Any]:
        return {"backend": "remote (OpenAI Decisions API)", "endpoint": ENDPOINT,
                "remote": True, "pinned_model": self.model}

    def predict(self, state: Any, questions: dict[str, dict[str, Any]]) -> dict[str, Any]:
        payload = {"model": self.model, "input": text(state),
                   "questions": [question(qid, q) for qid, q in questions.items()]}
        try:
            response = self.client.post(ENDPOINT, json=payload, headers=self.headers)
        except httpx.TimeoutException:
            raise RuntimeError("OpenAI request timed out; not retried (billing may still occur)") from None
        except httpx.HTTPError:
            raise RuntimeError("OpenAI transport failed; not retried") from None
        if response.status_code != 200:
            # Raw provider errors can echo private inputs; keep them out of logs/UI.
            message = f"OpenAI returned HTTP {response.status_code}; not retried"
            if response.status_code in (400, 422):
                raise ValueError(message)
            raise RuntimeError(message)
        try:
            body = response.json()
        except ValueError:
            raise ContractError("OpenAI returned invalid JSON") from None
        return translate(body, questions)


def load(model: str, device: str, threads: int | None) -> OpenAIPredictor:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set; see docs/runbooks/openai.md")
    return OpenAIPredictor(model, key)

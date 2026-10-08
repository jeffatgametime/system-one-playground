import copy
import json

import httpx
import pytest
from fastapi.testclient import TestClient

import engine_openai
from labkit.contract import ContractError, normalise_answers, parse_request
from labkit.server import EngineState, create_app

QUESTIONS = {
    "team": {"type": "choice", "instructions": {"task": "Which team?"},
             "criteria": {"billing": "Charges and refunds", "tech": None}},
    "impact": {"type": "score", "criteria": ["Cosmetic", {"description": "Blocked"}]},
    "refund": {"type": "noul", "instructions": "Does the customer ask for money back?"},
}
BODY = {"model": "gpt-6-luna", "answers": [
    {"name": "team", "type": "choice", "choice": "billing", "confidence": 0.6,
     "probabilities": [{"value": "billing", "probability": 0.9}, {"value": "tech", "probability": 0.1}]},
    {"name": "impact", "type": "score", "score": 0.8, "confidence": 0.7,
     "probabilities": [{"value": 0, "label": "0", "probability": 0.2}, {"value": 1, "label": "1", "probability": 0.8}]},
    {"name": "refund", "type": "predicate", "probability": 0.95},
], "usage": {"input_tokens": 42, "output_tokens": 0}}


def predictor(body=None, status=200):
    calls = []
    def handler(request):
        assert request.method == "POST" and str(request.url) == engine_openai.ENDPOINT
        assert request.headers["authorization"] == "Bearer synthetic-key"
        calls.append(json.loads(request.content))
        return httpx.Response(status, json=BODY if body is None else body)
    return calls, engine_openai.OpenAIPredictor(
        engine_openai.MODEL, "synthetic-key", httpx.Client(transport=httpx.MockTransport(handler)))


def test_three_types_and_structured_state_use_decisions_not_responses():
    calls, p = predictor()
    assert calls == [] and "synthetic-key" not in str(p.info())
    result = p.predict({"ticket": "Refund please"}, QUESTIONS)
    payload = calls[0]
    assert payload["model"] == "gpt-6-luna"
    assert json.loads(payload["input"]) == {"ticket": "Refund please"}
    assert [q["type"] for q in payload["questions"]] == ["choice", "score", "predicate"]
    assert [q["name"] for q in payload["questions"]] == list(QUESTIONS)
    assert payload["questions"][0]["choices"] == [{"value": "billing", "description": "Charges and refunds"}, {"value": "tech"}]
    assert payload["questions"][1]["levels"][1] == {"label": "1", "description": '{"description": "Blocked"}'}
    canonical = normalise_answers(parse_request({"state": "x", "questions": QUESTIONS}), result["answers"])
    assert canonical["team"]["choice"] == "billing"
    assert canonical["team"]["confidence"] == pytest.approx(0.8)
    assert canonical["team"]["engine"]["confidence"] == 0.6
    assert canonical["impact"]["score"] == pytest.approx(0.8)
    assert canonical["refund"]["noul"] == 0.95 and result["usage"]["input_tokens"] == 42


def test_predicate_criteria_and_unicode_preserved():
    q = {"type": "noul", "criteria": {"true": "Sí", "false": "No"}}
    translated = engine_openai.question("sí", q)
    assert translated["type"] == "predicate" and "Sí" in translated["instructions"]
    assert engine_openai.text("שלום") == "שלום"


@pytest.mark.parametrize("status", [400, 401, 403, 422, 429, 500, 503])
def test_errors_not_retried_or_echoed(status):
    calls, p = predictor({"error": "synthetic-secret-and-private-input"}, status)
    with pytest.raises((ValueError, RuntimeError), match=f"HTTP {status}") as exc:
        p.predict("x", QUESTIONS)
    assert len(calls) == 1 and "synthetic-secret" not in str(exc.value)


def test_timeout_not_retried():
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("synthetic-secret")
    p = engine_openai.OpenAIPredictor(engine_openai.MODEL, "synthetic-key", httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(RuntimeError, match="timed out") as exc:
        p.predict("x", QUESTIONS)
    assert len(calls) == 1 and "synthetic-secret" not in str(exc.value)


@pytest.mark.parametrize("index", range(3))
def test_refusals_fail_closed(index):
    body = copy.deepcopy(BODY)
    body["answers"][index] = {"name": list(QUESTIONS)[index], "type": "refusal"}
    _, p = predictor(body)
    with pytest.raises(ContractError, match="refused"): p.predict("x", QUESTIONS)


@pytest.mark.parametrize("bad", ["missing", "wrong_name", "wrong_type", "duplicates", "boolean_choice", "boolean_index", "wrong_model"])
def test_malformed_provider_answers_fail_closed(bad):
    body = copy.deepcopy(BODY)
    if bad == "missing": body["answers"].pop()
    if bad == "wrong_name": body["answers"][0]["name"] = "other"
    if bad == "wrong_type": body["answers"][2]["type"] = "score"
    if bad == "duplicates": body["answers"][0]["probabilities"][1]["value"] = "billing"
    if bad == "boolean_choice": body["answers"][0]["probabilities"][0]["value"] = True
    if bad == "boolean_index": body["answers"][1]["probabilities"][0]["value"] = False
    if bad == "wrong_model": body["model"] = "another-model"
    _, p = predictor(body)
    with pytest.raises(ContractError): p.predict("x", QUESTIONS)


def test_labkit_rejects_invalid_probability_and_refusal_as_502():
    for refusal in (False, True):
        body = {"model": engine_openai.MODEL, "usage": {}, "answers": [
            {"name": "refund", "type": "refusal"} if refusal else
            {"name": "refund", "type": "predicate", "probability": 1.5}]}
        _, p = predictor(body)
        state = EngineState("test", engine_openai.MODEL, "remote", None)
        state.status, state.predictor = "ready", p
        # No lifespan/warm-up in this ready test fixture; no remote credentials.
        client = TestClient(create_app(state, lambda *_: p))
        response = client.post("/v1/systemone", json={"state": "x", "questions": {"refund": QUESTIONS["refund"]}})
        assert response.status_code == 502
        client.close()


def test_missing_key_and_unsupported_model(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY is not set"):
        engine_openai.load(engine_openai.MODEL, "remote", None)
    with pytest.raises(ValueError, match="only gpt-6-luna"):
        engine_openai.OpenAIPredictor("another-model", "synthetic-key")

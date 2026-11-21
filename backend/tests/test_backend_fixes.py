"""Tests for the backend hardening pass (a)-(h) plus the best-effort fixes.

Covers: running/failed state machine + persisted failure reasons, the
GET /pipelines list, the per-pipeline 409 run lock, reject cleanup + git
rollback, projectPath sandboxing, LLM retries + _parse_response, structured
auto-review (no keyword scan, no forced pass), full skill text, heartbeat.
"""
import json
import threading
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import llm_runner
from backend.llm_runner import post_chat_completion as _real_post_chat_completion
from backend.main import app
from backend.pipeline_engine import auto_evaluate_review
from backend.storage import store
from test_pipeline_api import (
    _make_code_patch_json,
    _make_test_patch_json,
    approve_current_stage,
    approve_until_stage,
    create_pipeline,
    run_to_design_review,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def fake_llm(monkeypatch):
    store.clear()
    monkeypatch.setenv("DEVFLOW_LLM_ENABLED", "true")
    monkeypatch.setenv("DEVFLOW_LLM_API_KEY", "test-key")
    monkeypatch.setenv("DEVFLOW_LLM_BASE_URL", "https://api.lingyaai.cn")
    code_json = _make_code_patch_json()
    test_json = _make_test_patch_json()

    def fake_post(payload, stage_id=""):
        system_content = str(payload.get("messages", [{}])[0].get("content", ""))
        if "产品原型设计师" in system_content:
            return {"choices": [{"message": {"content": (
                "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
                "<title>需求原型</title></head><body><main><h1>任务筛选原型</h1>"
                "</main></body></html>"
            )}}]}
        if "可视化" in system_content:
            return {"choices": [{"message": {"content": json.dumps({
                "title": "测试方案", "summary": "测试",
                "nodes": [{"label": "A", "detail": "a"}, {"label": "B", "detail": "b"}],
                "risks": [],
            })}}]}
        if "代码生成器" in system_content:
            return {"choices": [{"message": {"content": code_json}}]}
        if "测试文件生成器" in system_content:
            return {"choices": [{"message": {"content": test_json}}]}
        return {"choices": [{"message": {"content": (
            "## 需求目标\n实现按优先级筛选任务功能\n\n"
            "## 评审结论\n建议交付\n\n缺少空状态处理"
        )}}]}

    monkeypatch.setattr(llm_runner, "post_chat_completion", fake_post)
    return fake_post


def _run_to_review_stage(pipeline_id):
    """Advance a fresh pipeline until the review stage is ready to run."""
    run_to_design_review(pipeline_id)
    approve_until_stage(pipeline_id, "review")
    result = client.post(f"/pipelines/{pipeline_id}/run-next").json()
    assert result["status"] == "waiting_review"
    assert result["currentStageId"] == "review"
    return result


# ── (a) running / failed state machine ──

def test_stage_runs_with_running_status(monkeypatch):
    """While a stage executes, pipeline.status is 'running'."""
    import backend.pipeline_engine as pe

    seen = {}
    orig = pe.run_llm_agent_with_metrics

    def spy(stage, pipeline):
        seen["status"] = pipeline.status
        return orig(stage, pipeline)

    monkeypatch.setattr(pe, "run_llm_agent_with_metrics", spy)
    pipeline = create_pipeline()
    response = client.post(f"/pipelines/{pipeline['id']}/run-next")
    assert response.status_code == 200
    assert seen["status"] == "running"


def test_failed_status_and_reason_are_persisted(monkeypatch):
    """An LLM failure marks the pipeline failed and persists the reason."""
    def boom(payload, stage_id=""):
        raise RuntimeError("boom")

    monkeypatch.setattr(llm_runner, "post_chat_completion", boom)
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    response = client.post(f"/pipelines/{pipeline_id}/run-next")
    assert response.status_code == 503

    fetched = client.get(f"/pipelines/{pipeline_id}").json()
    assert fetched["status"] == "failed"
    assert fetched["failureReason"]
    assert "boom" in fetched["failureReason"]
    assert fetched["failedStage"] == "requirement"
    assert fetched["stageFailures"]["requirement"]

    on_disk = json.loads(
        (Path("devflow-runs") / pipeline_id / "pipeline.json").read_text(encoding="utf-8")
    )
    assert on_disk["status"] == "failed"
    assert on_disk["failureReason"] == fetched["failureReason"]


def test_failed_pipeline_can_be_retried(monkeypatch):
    """After a failure, a retry with a working LLM succeeds again."""
    calls = {"n": 0}

    def flaky(payload, stage_id=""):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("first call fails")
        return {"choices": [{"message": {"content": "恢复后的需求分析结果"}}]}

    monkeypatch.setattr(llm_runner, "post_chat_completion", flaky)
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    assert client.post(f"/pipelines/{pipeline_id}/run-next").status_code == 503
    assert client.get(f"/pipelines/{pipeline_id}").json()["status"] == "failed"

    retried = client.post(f"/pipelines/{pipeline_id}/run-next").json()
    assert retried["status"] == "waiting_review"
    assert retried["failureReason"] is None


# ── (b) GET /pipelines list ──

def test_list_pipelines_endpoint():
    first = create_pipeline("需求一")
    second = create_pipeline("需求二")
    response = client.get("/pipelines")
    assert response.status_code == 200
    items = response.json()
    assert len(items) == 2
    # Most recently updated first.
    assert items[0]["id"] == second["id"]
    assert items[1]["id"] == first["id"]
    item = items[0]
    assert item["status"] == "ready"
    assert item["current_stage"] == "requirement"
    assert item["currentStageId"] == "requirement"
    assert item["updated_at"]
    assert item["failure_reason"] is None
    assert item["name"] == "需求二"


# ── (c) per-pipeline run lock + heartbeat ──

def test_concurrent_run_returns_409(monkeypatch):
    """Two simultaneous runs on the same pipeline: one 200, one 409."""
    # Slow fake: each LLM call takes 1.5s so the two threads overlap.
    code_json = _make_code_patch_json()

    def slow_post(payload, stage_id=""):
        time.sleep(1.5)
        system_content = str(payload.get("messages", [{}])[0].get("content", ""))
        if "产品原型设计师" in system_content:
            return {"choices": [{"message": {"content": "<html><body>原型</body></html>"}}]}
        if "代码生成器" in system_content:
            return {"choices": [{"message": {"content": code_json}}]}
        return {"choices": [{"message": {"content": "慢速 LLM 输出"}}]}

    monkeypatch.setattr(llm_runner, "post_chat_completion", slow_post)
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]

    results = []

    def call_run():
        results.append(client.post(f"/pipelines/{pipeline_id}/run-next").status_code)

    threads = [threading.Thread(target=call_run) for _ in range(2)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert sorted(results) == [200, 409]


def test_stream_run_emits_heartbeat():
    """SSE stream yields heartbeat events while running."""
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    run_to_design_review(pipeline_id)
    approve_until_stage(pipeline_id, "test")
    approve_current_stage(pipeline_id)  # approve test -> review is ready
    with client.stream("GET", f"/pipelines/{pipeline_id}/stream-run") as response:
        assert response.status_code == 200
        body = response.read().decode("utf-8")
    assert "event: heartbeat" in body
    assert '{"type": "heartbeat"}' in body
    fetched = client.get(f"/pipelines/{pipeline_id}").json()
    assert fetched["status"] == "waiting_review"


# ── (e) reject cleanup + git rollback ──

def test_reject_review_cleans_files_and_rolls_back_git():
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    _run_to_review_stage(pipeline_id)

    workspace = Path("devflow-runs") / pipeline_id / "workspace"
    target_app = Path("devflow-runs") / pipeline_id / "target-app"
    assert (workspace / "03-code.md").exists()
    assert (workspace / "04-test.md").exists()
    assert (workspace / "05-review.md").exists()
    assert "priorityFilter" in (target_app / "app.js").read_text(encoding="utf-8")

    rejected = client.post(
        f"/pipelines/{pipeline_id}/review",
        json={"decision": "reject", "reason": "代码有明显问题"},
    ).json()
    assert rejected["status"] == "ready"
    assert rejected["currentStageId"] == "code"
    assert "code" not in rejected["artifacts"]
    assert "test" not in rejected["artifacts"]
    assert "review" not in rejected["artifacts"]

    assert not (workspace / "03-code.md").exists()
    assert not (workspace / "04-test.md").exists()
    assert not (workspace / "05-review.md").exists()
    # Git rolled back to the pristine snapshot: the patched code is gone.
    app_js = (target_app / "app.js").read_text(encoding="utf-8")
    assert "priorityFilter" not in app_js
    assert "taskList" in app_js


def test_reject_without_git_marks_file_as_rejected_version(monkeypatch):
    """If git rollback is impossible, the file stays but is marked rejected."""
    import backend.pipeline_engine as pe

    monkeypatch.setattr(pe, "reset_to_commit", lambda ws, prefix: False)
    monkeypatch.setattr(pe, "rollback_before_commit", lambda ws, prefix: False)
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    _run_to_review_stage(pipeline_id)
    workspace = Path("devflow-runs") / pipeline_id / "workspace"
    assert (workspace / "03-code.md").exists()

    rejected = client.post(
        f"/pipelines/{pipeline_id}/review",
        json={"decision": "reject", "reason": "代码有明显问题"},
    ).json()
    assert rejected["status"] == "ready"
    # Rollback failed -> file kept, marked at the top as a rejected version.
    content = (workspace / "03-code.md").read_text(encoding="utf-8")
    assert content.startswith("> **已驳回版本**")


# ── (f) projectPath sandboxing + strict git commit ──

def test_project_path_is_sandboxed(tmp_path):
    src = tmp_path / "my-app"
    src.mkdir()
    (src / "index.html").write_text("<html>ORIGINAL</html>", encoding="utf-8")
    (src / "app.js").write_text("console.log('orig');\n", encoding="utf-8")

    response = client.post(
        "/pipelines",
        json={"requirement": "做一个待办清单", "projectPath": str(src)},
    )
    assert response.status_code == 200
    pipeline_id = response.json()["id"]

    run_to_design_review(pipeline_id)
    approve_until_stage(pipeline_id, "code")
    result = client.post(f"/pipelines/{pipeline_id}/run-next").json()
    assert result["status"] == "waiting_review"
    workspace_path = Path(result["artifacts"]["code"]["workspacePath"])
    # The patch went to the sandbox, never to the real project path.
    assert str(src) not in str(workspace_path)
    assert (src / "index.html").read_text(encoding="utf-8") == "<html>ORIGINAL</html>"
    assert (src / "app.js").read_text(encoding="utf-8") == "console.log('orig');\n"
    assert "ORIGINAL" not in (workspace_path / "index.html").read_text(encoding="utf-8")


def test_git_commit_failure_marks_pipeline_failed(monkeypatch):
    """A failing git commit surfaces as a failed stage instead of silence."""
    import backend.pipeline_engine as pe

    def boom_commit(workspace, message):
        raise RuntimeError("git commit exploded")

    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    run_to_design_review(pipeline_id)
    # Approve design only: code is now "ready" and has NOT run yet.
    # (approve_until_stage("code") would already have run the code stage.)
    approve_current_stage(pipeline_id)
    monkeypatch.setattr(pe, "commit_changes", boom_commit)
    response = client.post(f"/pipelines/{pipeline_id}/run-next")
    assert response.status_code == 503
    assert "Git 提交失败" in response.json()["detail"]
    fetched = client.get(f"/pipelines/{pipeline_id}").json()
    assert fetched["status"] == "failed"
    assert fetched["failedStage"] == "code"
    assert "Git 提交失败" in fetched["failureReason"]


# ── (g) LLM retries + _parse_response ──

def _http_error_response(status_code):
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(f"HTTP {status_code}", request=request, response=response)


def test_llm_retries_on_429_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def fake_httpx_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise _http_error_response(429)
        request = httpx.Request("POST", url)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok content"}}]},
            request=request,
        )

    monkeypatch.setattr(llm_runner, "post_chat_completion", _real_post_chat_completion)
    monkeypatch.setattr(llm_runner.httpx, "post", fake_httpx_post)
    monkeypatch.setattr(llm_runner, "_retry_sleep", lambda s: None)
    result = llm_runner.post_chat_completion({"model": "x", "messages": []}, "requirement")
    assert calls["n"] == 3
    assert result["choices"][0]["message"]["content"] == "ok content"


def test_llm_401_does_not_retry(monkeypatch):
    calls = {"n": 0}

    def fake_httpx_post(url, headers=None, json=None, timeout=None):
        calls["n"] += 1
        raise _http_error_response(401)

    monkeypatch.setattr(llm_runner, "post_chat_completion", _real_post_chat_completion)
    monkeypatch.setattr(llm_runner.httpx, "post", fake_httpx_post)
    monkeypatch.setattr(llm_runner, "_retry_sleep", lambda s: None)
    with pytest.raises(llm_runner.LLMError) as excinfo:
        llm_runner.post_chat_completion({"model": "x", "messages": []}, "requirement")
    assert calls["n"] == 1
    assert excinfo.value.kind == "config"
    assert "API Key" in str(excinfo.value)


def test_parse_response_never_uses_reasoning():
    content, _usage, reasoning = llm_runner._parse_response(
        {"choices": [{"message": {
            "content": "",
            "reasoning_content": '{"verdict": "pass", "issues": []}',
        }}]}
    )
    assert content == ""
    assert reasoning == '{"verdict": "pass", "issues": []}'

    content, _usage, _reasoning = llm_runner._parse_response(
        {"choices": [{"message": {
            "content": "real body",
            "reasoning_content": "much longer chain of thought " * 50,
        }}]}
    )
    assert content == "real body"


# ── (h) structured auto-review ──

def test_auto_evaluate_review_structured():
    ok, _fb = auto_evaluate_review(
        '报告正文\n```json\n{"verdict": "pass", "issues": []}\n```'
    )
    assert ok is True

    ok, fb = auto_evaluate_review(
        '```json\n{"verdict": "reject", "issues": ["空指针", "越界"]}\n```'
    )
    assert ok is False
    assert "空指针" in fb

    # Prose keywords no longer count: no JSON verdict means reject.
    ok, fb = auto_evaluate_review("## 评审结论\n建议交付\n代码质量良好")
    assert ok is False
    assert "结构化" in fb

    ok, _fb = auto_evaluate_review("")
    assert ok is False


def _auto_fake_post(monkeypatch, pass_verdict):
    """Fake LLM where the review synthesizer returns a structured verdict."""
    code_json = _make_code_patch_json()
    test_json = _make_test_patch_json()

    def fake_post(payload, stage_id=""):
        system_content = str(payload.get("messages", [{}])[0].get("content", ""))
        if "评审汇总专家" in system_content:
            verdict = "pass" if pass_verdict else "reject"
            issues = [] if pass_verdict else ["代码存在空指针问题"]
            body = "## 评审结论\n建议交付\n\n```json\n" + json.dumps(
                {"verdict": verdict, "issues": issues}, ensure_ascii=False
            ) + "\n```"
            return {"choices": [{"message": {"content": body}}]}
        if "产品原型设计师" in system_content:
            return {"choices": [{"message": {"content": "<html><body>原型</body></html>"}}]}
        if "可视化" in system_content:
            return {"choices": [{"message": {"content": json.dumps({
                "title": "测试方案", "summary": "测试",
                "nodes": [{"label": "A", "detail": "a"}, {"label": "B", "detail": "b"}],
                "risks": [],
            })}}]}
        if "代码生成器" in system_content:
            return {"choices": [{"message": {"content": code_json}}]}
        if "测试文件生成器" in system_content:
            return {"choices": [{"message": {"content": test_json}}]}
        return {"choices": [{"message": {"content": "LLM output"}}]}

    monkeypatch.setattr(llm_runner, "post_chat_completion", fake_post)


def test_auto_mode_passes_with_structured_verdict(monkeypatch):
    _auto_fake_post(monkeypatch, pass_verdict=True)
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    result = client.post(f"/pipelines/{pipeline_id}/run-until-review?auto=true").json()
    assert result["status"] == "completed"
    review_records = [r for r in result["reviewHistory"] if r["stageId"] == "review"]
    assert review_records and review_records[0]["decision"] == "approve"


def test_auto_mode_stops_for_human_after_max_rejects(monkeypatch):
    """3 auto-rejects must NOT force a pass: the 4th stops at waiting_review."""
    _auto_fake_post(monkeypatch, pass_verdict=False)
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    result = client.post(f"/pipelines/{pipeline_id}/run-until-review?auto=true").json()
    assert result["status"] == "waiting_review"
    assert result["currentStageId"] == "review"
    assert "review" in result["artifacts"]  # artifact kept for human review
    review_records = [r for r in result["reviewHistory"] if r["stageId"] == "review"]
    assert len([r for r in review_records if r["decision"] == "reject"]) == 4
    assert not any(r["decision"] == "approve" for r in review_records)
    assert not any("强制通过" in (r["reason"] or "") for r in result["reviewHistory"])


# ── best-effort fixes ──

def test_build_messages_includes_full_skill():
    """The full skill text (not just the first 2000 chars) reaches the LLM."""
    from backend.schemas import Pipeline as PipelineModel

    pipeline = create_pipeline()
    stored = store.get(pipeline["id"])
    assert isinstance(stored, PipelineModel)
    stage = stored.stages[0]
    messages = llm_runner.build_messages(stage, stored)
    system_content = messages[0]["content"]
    # This line sits near the end of the ~7KB requirements-analysis skill.
    assert "人工 Checkpoint 必须给出可操作的审核建议" in system_content
    assert len(system_content) > 2000


def test_model_router_defaults_unchanged_and_env_override(monkeypatch):
    assert llm_runner.MODEL_ROUTER == {
        "requirement": "deepseek-v4-flash",
        "design": "gpt-5.4",
        "code": "claude-sonnet-4-5-20250929",
        "test": "deepseek-v4-pro",
        "review": "claude-opus-4-7",
        "delivery": "deepseek-v4-flash",
    }
    assert llm_runner.get_model_for_stage("code") == "claude-sonnet-4-5-20250929"
    monkeypatch.setenv("DEVFLOW_MODEL_CODE", "my-custom-model")
    assert llm_runner.get_model_for_stage("code") == "my-custom-model"


def test_multi_agent_partial_failure_is_recorded(monkeypatch):
    """A reviewer that crashes is named in the report, not silently dropped."""
    from backend import multi_agent as ma

    def fake_post(payload, stage_id=""):
        system = payload["messages"][0]["content"]
        if "安全性角度审查" in system:
            raise Exception("Security agent crashed")
        if "正确性角度审查" in system:
            return {"choices": [{"message": {"content": "正确性审查：功能逻辑正确。"}}]}
        if "规范性角度审查" in system:
            return {"choices": [{"message": {"content": "规范性审查：代码风格一致。"}}]}
        if "评审汇总专家" in system:
            return {"choices": [{"message": {"content": (
                "## 评审结论\n建议交付\n\n## 正确性审查\n功能逻辑正确。\n\n"
                "## 安全性审查\n未发现漏洞。\n\n## 规范性审查\n风格一致。"
            )}}]}
        if "代码生成器" in system:
            return {"choices": [{"message": {"content": _make_code_patch_json()}}]}
        if "测试文件生成器" in system:
            return {"choices": [{"message": {"content": _make_test_patch_json()}}]}
        if "产品原型设计师" in system:
            return {"choices": [{"message": {"content": "<html><body>原型</body></html>"}}]}
        if "可视化" in system:
            return {"choices": [{"message": {"content": json.dumps({
                "title": "测试方案", "summary": "测试",
                "nodes": [{"label": "A", "detail": "a"}, {"label": "B", "detail": "b"}],
                "risks": [],
            })}}]}
        return {"choices": [{"message": {"content": "LLM output"}}]}

    monkeypatch.setattr(ma.llm_runner, "post_chat_completion", fake_post)
    pipeline = create_pipeline()
    pipeline_id = pipeline["id"]
    _run_to_review_stage(pipeline_id)
    result = client.get(f"/pipelines/{pipeline_id}").json()
    content = result["artifacts"]["review"]["content"]
    assert "正确性审查" in content
    assert "规范性审查" in content
    # The failed reviewer is explicitly recorded.
    assert "安全性审查" in content
    assert "未返回" in content

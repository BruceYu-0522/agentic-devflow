(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DevFlowCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STAGES = [
    { id: "requirement", name: "需求分析", agent: "需求分析 Agent", approvalRequired: true },
    { id: "design", name: "方案设计", agent: "方案设计 Agent", approvalRequired: true },
    { id: "code", name: "代码生成", agent: "代码生成 Agent", approvalRequired: true },
    { id: "test", name: "测试生成", agent: "测试生成 Agent", approvalRequired: true },
    { id: "review", name: "代码评审", agent: "代码评审 Agent", approvalRequired: true },
    { id: "delivery", name: "交付总结", agent: "交付总结 Agent", approvalRequired: true },
  ];

  // Five visually distinct stage states. The key rule: a stage that is
  // waiting for human review must NEVER look "complete", even though it
  // already has an artifact.
  var STAGE_STATES = ["pending", "running", "waiting_review", "complete", "failed"];

  var STAGE_STATE_LABELS = {
    pending: "待处理",
    running: "进行中",
    waiting_review: "待你审批",
    complete: "已完成",
    failed: "失败",
  };

  /**
   * Resolve the display state of one stage from the pipeline snapshot.
   * @param {string} stageId
   * @param {object|null} pipeline — { status, currentStageId, artifacts, failed_stage }
   * @returns {"pending"|"running"|"waiting_review"|"complete"|"failed"}
   */
  function resolveStageState(stageId, pipeline) {
    if (!pipeline) return "pending";
    var artifacts = pipeline.artifacts || {};
    var hasArtifact = !!artifacts[stageId];
    var isCurrent = pipeline.currentStageId === stageId;
    var status = pipeline.status;

    // A failed stage is failed, even if a partial artifact exists.
    // The API serializes camelCase (failedStage); accept snake_case too.
    var failedStageId = pipeline.failed_stage || pipeline.failedStage;
    if (status === "failed" && (failedStageId === stageId || (isCurrent && !failedStageId))) {
      return "failed";
    }
    // Waiting for review beats "has artifact": the artifact exists precisely
    // because this stage produced something that needs a human decision.
    if (status === "waiting_review" && isCurrent) return "waiting_review";
    if (status === "running" && isCurrent) return "running";
    if (hasArtifact) return "complete";
    if (status === "completed") return "complete";
    return "pending";
  }

  /**
   * Extract a 3-line summary layer from an artifact's Markdown:
   * key points, changed files and risks. Anything not found is left out
   * (the UI falls back to the first lines).
   * @param {string} markdown
   * @returns {{ points: string[], files: string[], risks: string[] }}
   */
  function extractArtifactSummary(markdown) {
    var text = String(markdown || "");
    var lines = text.split("\n");

    var points = [];
    var files = [];
    var risks = [];
    var inCodeFence = false;
    var inRiskSection = false;
    var seenFiles = {};

    function stripMd(line) {
      return line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/(\*\*|__|`)/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim();
    }

    function addFile(path) {
      if (!path || seenFiles[path] || files.length >= 8) return;
      seenFiles[path] = true;
      files.push(path);
    }

    var fileRe = /[\w./-]+\.(?:js|ts|tsx|jsx|html|css|json|md|py|vue)/g;

    lines.forEach(function (rawLine) {
      var line = rawLine.trim();
      if (/^```/.test(line)) {
        inCodeFence = !inCodeFence;
        return;
      }
      if (inCodeFence || !line) return;

      var heading = line.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        inRiskSection = /风险|注意|待确认|待澄清|问题|隐患|风险点/.test(heading[1]);
        var headText = stripMd(heading[1]);
        if (headText && points.length < 3 && !inRiskSection) points.push(headText);
        return;
      }

      // File paths: backticked tokens and table cells / list items naming files.
      var m;
      fileRe.lastIndex = 0;
      while ((m = fileRe.exec(line)) !== null) {
        addFile(m[0]);
      }

      if (/^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
        var item = stripMd(line);
        if (!item) return;
        if (inRiskSection) {
          if (risks.length < 4) risks.push(item);
          return;
        }
        // Skip list items that are only a file path (they already went to files).
        if (!/^[\w./-]+\.(?:js|ts|tsx|jsx|html|css|json|md|py|vue)/.test(item) && points.length < 3) {
          points.push(item.length > 60 ? item.slice(0, 60) + "…" : item);
        }
        return;
      }

      // Plain paragraph lines are fallback points.
      if (points.length < 3 && !inRiskSection && line.length > 4) {
        var plain = stripMd(line);
        if (plain && plain.length > 4) points.push(plain.length > 60 ? plain.slice(0, 60) + "…" : plain);
      }
    });

    return { points: points.slice(0, 3), files: files, risks: risks };
  }

  /**
   * Detect a structured review verdict in an artifact's Markdown:
   * a fenced JSON block (or inline JSON object) with { verdict: "pass"|"reject", issues: [...] }.
   * @param {string} markdown
   * @returns {{ verdict: "pass"|"reject", issues: string[] } | null}
   */
  function parseReviewVerdict(markdown) {
    var text = String(markdown || "");

    function normalize(obj) {
      if (!obj || (obj.verdict !== "pass" && obj.verdict !== "reject")) return null;
      var issues = [];
      if (Array.isArray(obj.issues)) {
        obj.issues.forEach(function (issue) {
          if (typeof issue === "string") {
            issues.push(issue);
          } else if (issue && typeof issue === "object") {
            issues.push(String(issue.title || issue.description || issue.message || JSON.stringify(issue)));
          }
        });
      }
      return { verdict: obj.verdict, issues: issues };
    }

    // 1) Fenced ```json blocks first.
    var fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
    var m;
    while ((m = fenceRe.exec(text)) !== null) {
      try {
        var found = normalize(JSON.parse(m[1]));
        if (found) return found;
      } catch (_) {}
    }

    // 2) Fallback: a brace-balanced object containing "verdict".
    var idx = text.indexOf('"verdict"');
    if (idx === -1) idx = text.indexOf("'verdict'");
    if (idx === -1) return null;
    var start = text.lastIndexOf("{", idx);
    if (start === -1) return null;
    var depth = 0;
    for (var i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            var parsed = normalize(JSON.parse(text.slice(start, i + 1)));
            if (parsed) return parsed;
          } catch (_) {}
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Create a DevFlow API client bound to a base URL.
   * @param {string} [baseUrl="http://127.0.0.1:8000"]
   */
  function createClient(baseUrl) {
    var apiBase = (baseUrl != null ? baseUrl : "http://127.0.0.1:8000").replace(/\/+$/, "");

    /**
     * @param {string} path
     * @param {RequestInit} [options]
     * @returns {Promise<any>}
     */
    async function request(path, options) {
      var headers = { "Content-Type": "application/json" };
      if (options && options.headers) {
        headers = Object.assign(headers, options.headers);
      }

      var url = apiBase + path;
      console.log("[pipeline-core request] " + (options ? options.method || "GET" : "GET") + " " + url);

      var response;
      try {
        response = await fetch(url, Object.assign({}, options, { headers: headers }));
        console.log("[pipeline-core request] response status:", response.status);
      } catch (_err) {
        console.error("[pipeline-core request] fetch failed:", _err.message || _err);
        throw new Error(
          "API 服务未连接。请先启动后端：\n" +
          "  pip install -r requirements.txt\n" +
          "  uvicorn backend.main:app --reload\n\n" +
          "然后确保设置了 LLM 环境变量：\n" +
          "  DEVFLOW_LLM_ENABLED=true\n" +
          "  DEVFLOW_LLM_API_KEY=你的API密钥\n" +
          "  DEVFLOW_LLM_BASE_URL=https://api.lingyaai.cn"
        );
      }

      if (!response.ok) {
        var message = "API 请求失败：" + response.status;
        try {
          var payload = await response.json();
          message = payload.detail || message;
        } catch (_e) {
          message = response.statusText || message;
        }
        var error = new Error(message);
        error.status = response.status;
        throw error;
      }

      return response.json();
    }

    return {
      health: function () {
        return request("/health");
      },

      createPipeline: function (requirement, projectPath, template) {
        return request("/pipelines", {
          method: "POST",
          body: JSON.stringify({
            requirement: requirement,
            projectPath: projectPath || undefined,
            template: template || "feature",
          }),
        });
      },

      getPipeline: function (pipelineId) {
        return request("/pipelines/" + pipelineId);
      },

      listPipelines: function () {
        return request("/pipelines");
      },

      runUntilReview: function (pipelineId) {
        return request("/pipelines/" + pipelineId + "/run-until-review", {
          method: "POST",
        });
      },

      runNext: function (pipelineId) {
        return request("/pipelines/" + pipelineId + "/run-next", {
          method: "POST",
        });
      },

      submitReview: function (pipelineId, decision, reason) {
        return request("/pipelines/" + pipelineId + "/review", {
          method: "POST",
          body: JSON.stringify({
            decision: decision,
            reason: reason || "",
          }),
        });
      },
    };
  }

  return {
    STAGES: STAGES,
    STAGE_STATES: STAGE_STATES,
    STAGE_STATE_LABELS: STAGE_STATE_LABELS,
    resolveStageState: resolveStageState,
    extractArtifactSummary: extractArtifactSummary,
    parseReviewVerdict: parseReviewVerdict,
    createClient: createClient,
  };
});

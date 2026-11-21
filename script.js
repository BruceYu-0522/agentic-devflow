// ── Global error trap for debugging ──
window.addEventListener("error", function (event) {
  console.error("[global error]", event.message, "at", event.filename, ":", event.lineno, ":", event.colno, "source:", event.target);
});
window.addEventListener("unhandledrejection", function (event) {
  console.error("[unhandled rejection]", event.reason);
});

var STAGES = window.DevFlowCore.STAGES;
var core = window.DevFlowCore;
var client = window.DevFlowCore.createClient(window.DEVFLOW_API_BASE);
var artifactRenderer = window.DevFlowArtifactRenderer;
var clarificationFlow = window.DevFlowClarificationFlow;

var pipeline = null;
var isRunning = false;
var runningStageName = "";
var runErrorMessage = "";
var abortController = null;
var pendingRequirement = "";
var pendingTemplate = "feature";
var liveOutputEventSource = null;
var lastHeartbeatAt = 0;
var liveLineCount = 0;
var clarificationStepIndex = 0;
var clarificationAnswers = {};
var userToggledSections = {}; // stageId → true（用户手动折叠/展开过，渲染时保留他的选择）

var STORAGE_KEY = "devflow:lastPipelineId";

var elements = {
  form: document.querySelector("#requestForm"),
  requirementInput: document.querySelector("#requirementInput"),
  templateSelector: document.querySelector("#templateSelector"),
  resetButton: document.querySelector("#resetButton"),
  historyButton: document.querySelector("#historyButton"),
  historyPanel: document.querySelector("#historyPanel"),
  historyList: document.querySelector("#historyList"),
  historyClose: document.querySelector("#historyClose"),
  deliveryPackage: document.querySelector("#deliveryPackage"),
  productPreviewSection: document.querySelector("#productPreviewSection"),
  productPreviewFrame: document.querySelector("#productPreviewFrame"),
  productPreviewLink: document.querySelector("#productPreviewLink"),
  productExpandBtn: document.querySelector("#productExpandBtn"),
  productFrameWrap: document.querySelector("#productFrameWrap"),
  deliverySummaryBody: document.querySelector("#deliverySummaryBody"),
  deliveryStats: document.querySelector("#deliveryStats"),
  deliveryFiles: document.querySelector("#deliveryFiles"),
  pipelineStatus: document.querySelector("#pipelineStatus"),
  stageCount: document.querySelector("#stageCount"),
  stageList: document.querySelector("#stageList"),
  failureBanner: document.querySelector("#failureBanner"),
  // Live output
  liveOutput: document.querySelector("#liveOutput"),
  obsPanel: document.querySelector("#obsPanel"),
  obsCards: document.querySelector("#obsCards"),
  obsSummary: document.querySelector("#obsSummary"),
  liveOutputStream: document.querySelector("#liveOutputStream"),
  liveOutputTitle: document.querySelector("#liveOutputTitle"),
  liveOutputStage: document.querySelector("#liveOutputStage"),
  liveOutputEmpty: document.querySelector("#liveOutputEmpty"),
  liveOutputSummary: document.querySelector("#liveOutputSummary"),
  liveOutputSummaryText: document.querySelector("#liveOutputSummaryText"),
  liveOutputExpandBtn: document.querySelector("#liveOutputExpandBtn"),
  // Artifacts
  currentAgent: document.querySelector("#currentAgent"),
  artifactEmpty: document.querySelector("#artifactEmpty"),
  artifactCard: document.querySelector("#artifactCard"),
  artifactSections: document.querySelector("#artifactSections"),
  // Approval bar (sticky, top of the artifact panel)
  approvalBar: document.querySelector("#approvalBar"),
  approvalStageName: document.querySelector("#approvalStageName"),
  reviewPanel: document.querySelector("#review"),
  reviewState: document.querySelector("#reviewState"),
  reviewHistoryEmpty: document.querySelector("#reviewHistoryEmpty"),
  reviewHistoryList: document.querySelector("#reviewHistoryList"),
  rejectReason: document.querySelector("#rejectReason"),
  approveButton: document.querySelector("#approveButton"),
  rejectButton: document.querySelector("#rejectButton"),
  clarificationModal: document.querySelector("#clarificationModal"),
  clarificationForm: document.querySelector("#clarificationForm"),
  clarificationRequirement: document.querySelector("#clarificationRequirement"),
  clarificationQuestions: document.querySelector("#clarificationQuestions"),
  clarificationCancel: document.querySelector("#clarificationCancel"),
  clarificationSkip: document.querySelector("#clarificationSkip"),
  clarificationRecommend: document.querySelector("#clarificationRecommend"),
  clarificationProgress: document.querySelector("#clarificationProgress"),
  clarificationStepLabel: document.querySelector("#clarificationStepLabel"),
  clarificationStepQuestion: document.querySelector("#clarificationStepQuestion"),
  clarificationStepHint: document.querySelector("#clarificationStepHint"),
  clarificationStepAnswer: document.querySelector("#clarificationStepAnswer"),
  clarificationDots: document.querySelector("#clarificationDots"),
  clarificationPrev: document.querySelector("#clarificationPrev"),
  clarificationNext: document.querySelector("#clarificationNext"),
  // Workspace
  workspace: document.querySelector("#workspace"),
  workspaceFileList: document.querySelector("#workspaceFileList"),
  workspaceFileCount: document.querySelector("#workspaceFileCount"),
  workspaceEmpty: document.querySelector("#workspaceEmpty"),
  workspacePath: document.querySelector("#workspacePath"),
  exportWorkspaceLink: document.querySelector("#exportWorkspaceLink"),
  workspaceGit: document.querySelector("#workspaceGit"),
  gitBranch: document.querySelector("#gitBranch"),
  gitCommit: document.querySelector("#gitCommit"),
  codeSearch: document.querySelector("#codeSearch"),
  codeSearchInput: document.querySelector("#codeSearchInput"),
  codeSearchResults: document.querySelector("#codeSearchResults"),
};

// ── Pipeline helpers ──

function getStages() {
  return (pipeline && pipeline.stages) ? pipeline.stages : STAGES;
}

function getCompletedStageIds() {
  if (!pipeline) return new Set();
  return new Set(Object.keys(pipeline.artifacts));
}

function getLatestArtifact() {
  if (!pipeline) return null;
  var completedIds = Object.keys(pipeline.artifacts);
  if (completedIds.length === 0) return null;
  return pipeline.artifacts[completedIds[completedIds.length - 1]];
}

function getCurrentStage() {
  if (!pipeline) return null;
  var found = null;
  getStages().forEach(function (stage) {
    if (stage.id === pipeline.currentStageId) found = stage;
  });
  return found;
}

function getArtifact(stageId) {
  return pipeline && pipeline.artifacts ? pipeline.artifacts[stageId] : null;
}

function getProductPreviewUrl() {
  if (!pipeline) return "";
  var codeArtifact = getArtifact("code");
  if (!codeArtifact || !codeArtifact.workspacePath) return "";
  return window.DEVFLOW_API_BASE + "/runs/" + pipeline.id + "/target-app/index.html";
}

// ── localStorage：刷新恢复 ──

function saveLastPipelineId(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch (_) {}
}

function loadLastPipelineId() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
}

function clearLastPipelineId() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

// ── 顶部状态徽标：如实反映状态，ready 下绝不显示运行中样式 ──

function setStatusBadge() {
  var pill = elements.pipelineStatus;
  pill.classList.remove("is-running", "is-review", "is-done", "is-failed");
  pill.title = "";

  if (runErrorMessage) {
    pill.textContent = "错误：" + runErrorMessage;
    pill.classList.add("is-failed");
    return;
  }

  if (isRunning || (pipeline && pipeline.status === "running")) {
    pill.textContent = "运行中";
    pill.classList.add("is-running");
    return;
  }

  if (!pipeline) {
    pill.textContent = "未开始";
    return;
  }

  if (pipeline.status === "failed") {
    var failedStage = getStages().filter(function (s) { return s.id === (pipeline.failed_stage || pipeline.failedStage); })[0];
    pill.textContent = "失败" + (failedStage ? " · " + failedStage.name : "");
    pill.classList.add("is-failed");
    if (pipeline.failure_reason || pipeline.failureReason) pill.title = pipeline.failure_reason || pipeline.failureReason;
    return;
  }

  if (pipeline.status === "completed") {
    pill.textContent = "已完成";
    pill.classList.add("is-done");
    return;
  }

  if (pipeline.status === "waiting_review") {
    pill.textContent = "等待你确认";
    pill.classList.add("is-review");
    return;
  }

  // ready：空闲就绪，不加任何运行中脉冲
  var next = getCurrentStage();
  pill.textContent = next ? "就绪 · 下一步：" + next.name : "就绪";
}

// ── Live output panel ──
// 流式进行中只在终端显示；完成后终端收起为一行摘要，产物面板展示最终产物。
// 打回时不清空，而是把上一轮输出折叠归档。

function showLiveOutput() {
  elements.liveOutputEmpty.classList.add("hidden");
}

function hideLiveOutput() {
  clearLiveOutput();
  clearLiveArchives();
  elements.liveOutputSummary.classList.add("hidden");
}

function clearLiveOutput() {
  // Remove dynamically-added children but keep liveOutputEmpty and
  // archived previous rounds (.live-archive) in the DOM.
  var children = elements.liveOutputStream.children;
  for (var i = children.length - 1; i >= 0; i--) {
    if (children[i].id !== "liveOutputEmpty" && !children[i].classList.contains("live-archive")) {
      children[i].remove();
    }
  }
  elements.liveOutputEmpty.classList.remove("hidden");
  elements.liveOutputTitle.textContent = "AI 正在工作…";
  elements.liveOutputStage.textContent = "等待中";
  liveLineCount = 0;
}

function clearLiveArchives() {
  elements.liveOutputStream.querySelectorAll(".live-archive").forEach(function (el) { el.remove(); });
}

function collapseLiveOutput() {
  if (liveLineCount <= 0) return;
  elements.liveOutputStream.classList.add("hidden");
  elements.liveOutputSummaryText.textContent = "已完成 · " + liveLineCount + " 行输出";
  elements.liveOutputSummary.classList.remove("hidden");
}

function expandLiveOutput() {
  elements.liveOutputStream.classList.remove("hidden");
  elements.liveOutputSummary.classList.add("hidden");
}

function archiveLiveOutput() {
  var stream = elements.liveOutputStream;
  var nodes = Array.prototype.slice.call(stream.children).filter(function (el) {
    return el.id !== "liveOutputEmpty" && !el.classList.contains("live-archive");
  });
  if (nodes.length === 0) return;
  var details = document.createElement("details");
  details.className = "live-archive";
  var summary = document.createElement("summary");
  summary.textContent = "上一轮输出 · " + liveLineCount + " 行（已打回）";
  details.appendChild(summary);
  nodes.forEach(function (n) { details.appendChild(n); });
  stream.appendChild(details);
  liveLineCount = 0;
  elements.liveOutputSummary.classList.add("hidden");
}

function appendLiveChunk(text) {
  showLiveOutput();
  elements.liveOutputEmpty.classList.add("hidden");
  liveLineCount += String(text).split("\n").length;
  var span = document.createElement("span");
  span.className = "stream-chunk";
  span.textContent = text;
  elements.liveOutputStream.appendChild(span);
  elements.liveOutputStream.scrollTop = elements.liveOutputStream.scrollHeight;
}

function appendSystemMessage(text) {
  showLiveOutput();
  elements.liveOutputEmpty.classList.add("hidden");
  liveLineCount += 1;
  var div = document.createElement("div");
  div.className = "stream-system";
  div.textContent = "⚙ " + text;
  elements.liveOutputStream.appendChild(div);
  elements.liveOutputStream.scrollTop = elements.liveOutputStream.scrollHeight;
}

function appendErrorMessage(text) {
  showLiveOutput();
  elements.liveOutputEmpty.classList.add("hidden");
  liveLineCount += 1;
  var div = document.createElement("div");
  div.className = "stream-error";
  div.textContent = "✕ " + text;
  elements.liveOutputStream.appendChild(div);
  elements.liveOutputStream.scrollTop = elements.liveOutputStream.scrollHeight;
}

function setLiveOutputStage(stageName) {
  elements.liveOutputStage.textContent = stageName;
  elements.liveOutputTitle.textContent = "正在执行：" + stageName;
}

// ── Observability Panel ──

var _statsCards = {};  // stageId → stats data

function addStatsCard(stats) {
  _statsCards[stats.stageId] = stats;
  renderStatsPanel();
}

function renderStatsPanel() {
  var cards = Object.values(_statsCards);
  if (cards.length === 0) {
    elements.obsPanel.classList.add("hidden");
    return;
  }

  elements.obsPanel.classList.remove("hidden");

  // Summary
  var totalLatency = 0;
  var totalTokens = 0;
  cards.forEach(function (s) {
    totalLatency += s.latencyMs || 0;
    totalTokens += s.totalTokens || 0;
  });

  var latencyDisplay = totalLatency > 1000
    ? (totalLatency / 1000).toFixed(1) + "s"
    : totalLatency + "ms";
  elements.obsSummary.innerHTML =
    '<span class="obs-metric">总耗时 <strong>' + latencyDisplay + '</strong></span>' +
    '<span class="obs-metric">Token <strong>' + formatNumber(totalTokens) + '</strong></span>' +
    '<span class="obs-metric">阶段 <strong>' + cards.length + '</strong></span>';

  // Cards — sort by stage order
  var stageOrder = ["requirement", "design", "code", "test", "review", "delivery"];
  var sorted = cards.slice().sort(function (a, b) {
    return stageOrder.indexOf(a.stageId) - stageOrder.indexOf(b.stageId);
  });

  elements.obsCards.innerHTML = sorted.map(function (s) {
    var latencyStr = s.latencyMs > 1000
      ? (s.latencyMs / 1000).toFixed(1) + "s"
      : s.latencyMs + "ms";
    return (
      '<div class="obs-card">' +
        '<div class="obs-card-head">' +
          '<span class="obs-card-stage ' + s.stageId + '">' + artifactRenderer.escapeHtml(s.stageName) + '</span>' +
          '<span class="obs-card-model">' + artifactRenderer.escapeHtml(s.model) + '</span>' +
        '</div>' +
        '<div class="obs-card-metrics">' +
          '<div class="obs-metric-item">' +
            '<span class="obs-metric-label">耗时</span>' +
            '<span class="obs-metric-value">' + latencyStr + '</span>' +
          '</div>' +
          '<div class="obs-metric-item">' +
            '<span class="obs-metric-label">输入 Token</span>' +
            '<span class="obs-metric-value">' + formatNumber(s.promptTokens) + '</span>' +
          '</div>' +
          '<div class="obs-metric-item">' +
            '<span class="obs-metric-label">输出 Token</span>' +
            '<span class="obs-metric-value">' + formatNumber(s.completionTokens) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join("");
}

function formatNumber(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function disconnectLiveOutput() {
  if (liveOutputEventSource) {
    liveOutputEventSource.close();
    liveOutputEventSource = null;
  }
}

function connectLiveOutput(pipelineId) {
  disconnectLiveOutput();
  clearLiveOutput();
  elements.liveOutputSummary.classList.add("hidden");
  elements.liveOutputStream.classList.remove("hidden");
  showLiveOutput();

  return new Promise(function (resolve, reject) {
    try {
      liveOutputEventSource = new EventSource(
        window.DEVFLOW_API_BASE + "/pipelines/" + pipelineId + "/stream-run"
      );

      liveOutputEventSource.addEventListener("chunk", function (event) {
        appendLiveChunk(event.data);
      });

      liveOutputEventSource.addEventListener("system", function (event) {
        appendSystemMessage(event.data);
      });

      liveOutputEventSource.addEventListener("stage", function (event) {
        setLiveOutputStage(event.data);
      });

      // 后端定期发送的心跳：只记录到达时间，不打扰界面。
      liveOutputEventSource.addEventListener("heartbeat", function () {
        lastHeartbeatAt = Date.now();
      });

      liveOutputEventSource.addEventListener("stats", function (event) {
        try {
          var statsData = JSON.parse(event.data);
          addStatsCard(statsData);
        } catch (_) {}
      });

      liveOutputEventSource.addEventListener("auto_regression", function (event) {
        try {
          var regData = JSON.parse(event.data);
          appendSystemMessage(
            "⚠️ 自动回归：检测到评审问题，自动打回重新生成 " +
              regData.stageName +
              " (" + regData.retry + "/" + regData.maxRetries + ")\n" +
              "原因：" + regData.reason
          );
        } catch (_) {}
      });

      liveOutputEventSource.addEventListener("fail", function (event) {
        if (event.data) {
          appendErrorMessage(event.data);
        }
      });

      liveOutputEventSource.addEventListener("done", function () {
        appendSystemMessage("阶段执行完成");
        disconnectLiveOutput();
        resolve();
      });

      liveOutputEventSource.onerror = function () {
        if (liveOutputEventSource && liveOutputEventSource.readyState === EventSource.CLOSED) {
          resolve();
        }
        disconnectLiveOutput();
      };
    } catch (_e) {
      liveOutputEventSource = null;
      reject(_e);
    }
  });
}

// ── Render functions ──

function renderStages() {
  var completedIds = getCompletedStageIds();
  var labels = core.STAGE_STATE_LABELS;

  elements.stageList.innerHTML = getStages().map(function (stage, index) {
    var state = core.resolveStageState(stage.id, pipeline);
    var stateLabel = labels[state];

    return (
      '<li class="stage-card is-' + state + '" data-stage-id="' + stage.id + '">' +
        '<span class="card-alert">需审批</span>' +
        '<span class="card-num">' + (index + 1) + "</span>" +
        '<span class="card-name">' + stage.name + "</span>" +
        '<span class="card-state">' + stateLabel + "</span>" +
      "</li>"
    );
  }).join("");

  elements.stageCount.textContent = completedIds.size + " / " + getStages().length;

  // 失败横幅：写明哪个阶段、为什么失败
  if (pipeline && pipeline.status === "failed") {
    var failedStage = getStages().filter(function (s) { return s.id === (pipeline.failed_stage || pipeline.failedStage); })[0];
    var failedName = failedStage ? failedStage.name : "某阶段";
    elements.failureBanner.innerHTML =
      "<strong>✕ " + artifactRenderer.escapeHtml(failedName) + " 失败</strong>" +
      ((pipeline.failure_reason || pipeline.failureReason) ? " — " + artifactRenderer.escapeHtml(pipeline.failure_reason || pipeline.failureReason) : " — 请重试或新建运行");
    elements.failureBanner.classList.remove("hidden");
  } else {
    elements.failureBanner.classList.add("hidden");
    elements.failureBanner.textContent = "";
  }

  // Click-to-scroll for completed and waiting-review stages
  elements.stageList.querySelectorAll(".stage-card.is-complete, .stage-card.is-waiting_review").forEach(function (card) {
    card.addEventListener("click", function () {
      var stageId = card.dataset.stageId;
      var target = document.querySelector("#artifact-" + stageId);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        // Expand the section if collapsed
        var body = target.querySelector(".artifact-section-body");
        if (body && body.classList.contains("collapsed")) {
          var bar = target.querySelector(".artifact-section-bar");
          if (bar) bar.click();
        }
        // Brief highlight
        target.style.boxShadow = "0 0 0 3px rgba(184,241,53,0.35)";
        setTimeout(function () { target.style.boxShadow = ""; }, 1500);
      }
    });
  });
}

function buildArtifactSummaryHtml(stageId, artifact) {
  var summary = core.extractArtifactSummary(artifact.content || "");
  var files = summary.files.slice();
  (artifact.changedFiles || []).forEach(function (f) {
    if (files.indexOf(f) === -1) files.push(f);
  });

  var html = '<div class="artifact-summary">';

  if (summary.points.length > 0) {
    html += '<ul class="summary-points">' + summary.points.map(function (p) {
      return "<li>" + artifactRenderer.escapeHtml(p) + "</li>";
    }).join("") + "</ul>";
  } else {
    html += '<p class="summary-empty-note">暂无摘要，展开查看全文。</p>';
  }

  if (files.length > 0) {
    html += '<div class="summary-row"><span class="summary-row__label">改动文件</span>' +
      files.map(function (f) {
        return '<span class="summary-chip">' + artifactRenderer.escapeHtml(f) + "</span>";
      }).join("") + "</div>";
  }

  if (summary.risks.length > 0) {
    html += '<div class="summary-row"><span class="summary-row__label">风险</span>' +
      summary.risks.map(function (r) {
        return '<span class="summary-chip summary-chip--risk">' + artifactRenderer.escapeHtml(r) + "</span>";
      }).join("") + "</div>";
  }

  html += "</div>";
  return html;
}

function buildVerdictCardHtml(artifact) {
  var verdict = core.parseReviewVerdict(artifact.content || "");
  if (!verdict) return "";
  var isPass = verdict.verdict === "pass";
  var html = '<div class="verdict-card ' + (isPass ? "verdict-pass" : "verdict-reject") + '">' +
    "<strong>" + (isPass ? "✓ 评审结论：通过" : "✕ 评审结论：驳回") + "</strong>";
  if (verdict.issues.length > 0) {
    html += "<ul>" + verdict.issues.map(function (issue) {
      return "<li>" + artifactRenderer.escapeHtml(issue) + "</li>";
    }).join("") + "</ul>";
  }
  html += "</div>";
  return html;
}

function renderArtifact() {
  var completedIds = Object.keys(pipeline ? pipeline.artifacts : {});

  if (completedIds.length === 0) {
    elements.artifactEmpty.classList.remove("hidden");
    elements.artifactCard.classList.add("hidden");
    elements.currentAgent.textContent = pipeline ? "等待 AI Agent 生成" : "等待开始";
    return;
  }

  elements.artifactEmpty.classList.add("hidden");
  elements.artifactCard.classList.remove("hidden");

  var latestArtifact = getLatestArtifact();
  elements.currentAgent.textContent = latestArtifact && latestArtifact.model
    ? latestArtifact.agent + " · " + latestArtifact.model
    : latestArtifact ? latestArtifact.agent : "";

  var tagClassMap = {
    "requirement": "stage-tag-req",
    "design": "stage-tag-design",
    "code": "stage-tag-code",
    "test": "stage-tag-test",
    "review": "stage-tag-review",
    "delivery": "stage-tag-delivery",
  };

  // Track existing sections to reuse DOM elements
  var existingSections = {};
  var children = elements.artifactSections.children;
  for (var i = 0; i < children.length; i++) {
    existingSections[children[i].dataset.stageId] = children[i];
  }

  // Sort artifacts by stage order, latest first
  var orderedIds = [];
  getStages().forEach(function (stage) {
    if (pipeline.artifacts[stage.id]) orderedIds.push(stage.id);
  });
  orderedIds.reverse();

  orderedIds.forEach(function (stageId) {
    var artifact = pipeline.artifacts[stageId];
    var existing = existingSections[stageId];
    var section = existing || document.createElement("section");
    var state = core.resolveStageState(stageId, pipeline);
    section.className = "artifact-section is-" + state;
    section.id = "artifact-" + stageId;
    section.dataset.stageId = stageId;

    // 全文默认折叠，只把当前待审批的那一段展开；用户手动折叠/展开过则保留他的选择。
    var isCurrentWaiting = state === "waiting_review";
    var isCollapsed = userToggledSections[stageId]
      ? section.dataset.collapsed === "true"
      : !isCurrentWaiting;
    var tagClass = tagClassMap[stageId] || "";

    section.innerHTML =
      '<div class="artifact-section-bar">' +
        '<span class="stage-tag ' + tagClass + '">' + artifact.stageName + '</span>' +
        '<button class="artifact-section-toggle" type="button">' + (isCollapsed ? "▸" : "▾") + '</button>' +
      '</div>' +
      buildVerdictCardHtml(artifact) +
      buildArtifactSummaryHtml(stageId, artifact) +
      '<div class="artifact-section-body' + (isCollapsed ? " collapsed" : "") + '">' +
        '<div class="markdown-document">' + artifactRenderer.renderMarkdown(artifact.content) + '</div>' +
        '<div class="section-extras" id="extras-' + stageId + '"></div>' +
      '</div>';
    section.dataset.collapsed = isCollapsed ? "true" : "false";

    if (!existing) {
      elements.artifactSections.appendChild(section);
    } else {
      // Re-append to move to correct position (newest first)
      elements.artifactSections.appendChild(section);
    }

    // Bind toggle click
    var bar = section.querySelector(".artifact-section-bar");
    bar.addEventListener("click", function (s, sid) {
      return function () {
        var body = s.querySelector(".artifact-section-body");
        var toggleBtn = s.querySelector(".artifact-section-toggle");
        var isNowCollapsed = !body.classList.contains("collapsed");
        body.classList.toggle("collapsed");
        toggleBtn.textContent = isNowCollapsed ? "▸" : "▾";
        s.dataset.collapsed = isNowCollapsed ? "true" : "false";
        userToggledSections[sid] = true;
      };
    }(section, stageId));

    delete existingSections[stageId];
  });

  // Remove sections for stages that no longer have artifacts
  Object.keys(existingSections).forEach(function (id) {
    existingSections[id].remove();
  });

  // Render stage-specific extras
  renderPrdMap();
  renderPrototype();
  renderVisualPlan(getArtifact("design") ? getArtifact("design").visualPlan : null);
  renderCodeViewers();
  renderProductPreviewInCodeStage();
}

function renderPrdMap() {
  var reqArtifact = getArtifact("requirement");
  var extrasEl = document.querySelector("#extras-requirement");
  if (!reqArtifact || !extrasEl) return;

  // Remove old prdMap from extras
  var oldPrd = extrasEl.querySelector(".prd-map-inline");
  if (oldPrd) oldPrd.remove();

  var prdMap = artifactRenderer.buildPrdMap(reqArtifact.content);
  var wrapper = document.createElement("div");
  wrapper.className = "prd-map-inline";
  wrapper.innerHTML =
    '<div class="visual-plan-header">' +
      '<strong>' + artifactRenderer.escapeHtml(prdMap.title) + '</strong>' +
      '<p>' + artifactRenderer.escapeHtml(prdMap.summary || "") + '</p>' +
    '</div>' +
    '<div class="prd-map-flow">' + artifactRenderer.renderPrdMap(prdMap) + '</div>';
  extrasEl.appendChild(wrapper);
}

function renderPrototype() {
  var reqArtifact = getArtifact("requirement");
  var extrasEl = document.querySelector("#extras-requirement");
  if (!reqArtifact || !reqArtifact.prototypeHtml || !extrasEl) return;

  var oldProto = extrasEl.querySelector(".prototype-inline");
  if (oldProto) oldProto.remove();

  var wrapper = document.createElement("div");
  wrapper.className = "prototype-inline";
  wrapper.innerHTML =
    '<div class="visual-plan-header">' +
      '<strong>低保真原型预览</strong>' +
      '<p>AI 产品经理根据需求分析自动生成的原型页面</p>' +
      '<button class="ghost-button expand-preview-btn inline-expand-btn" type="button">全屏查看</button>' +
    '</div>' +
    '<div class="product-preview-frame">' +
      '<iframe srcdoc="' + artifactRenderer.escapeHtml(reqArtifact.prototypeHtml).replace(/"/g, "&quot;") + '" sandbox="allow-scripts allow-same-origin allow-forms" title="需求原型预览"></iframe>' +
    '</div>';
  extrasEl.appendChild(wrapper);

  // Bind expand button
  var expandBtn = wrapper.querySelector(".inline-expand-btn");
  var frameWrap = wrapper.querySelector(".product-preview-frame");
  expandBtn.addEventListener("click", function () {
    if (expandedFrameWrap === frameWrap) {
      collapsePreview();
    } else {
      collapsePreview();
      expandPreview(frameWrap);
    }
  });
}

function renderVisualPlan(visualPlan) {
  var extrasEl = document.querySelector("#extras-design");
  if (!visualPlan || !extrasEl) return;

  var oldVp = extrasEl.querySelector(".visual-plan-inline");
  if (oldVp) oldVp.remove();

  var wrapper = document.createElement("div");
  wrapper.className = "visual-plan-inline";
  wrapper.innerHTML =
    '<div class="visual-plan-header">' +
      '<strong>' + artifactRenderer.escapeHtml(visualPlan.title) + '</strong>' +
      '<p>' + artifactRenderer.escapeHtml(visualPlan.summary || "") + '</p>' +
    '</div>' +
    '<div class="blueprint-flow"></div>' +
    '<div class="blueprint-risks"></div>';

  var flowEl = wrapper.querySelector(".blueprint-flow");
  visualPlan.nodes.forEach(function (node, index) {
    var card = document.createElement("article");
    card.className = "blueprint-node";
    var step = document.createElement("span");
    var numStr = String(index + 1);
    step.textContent = numStr.length === 1 ? "0" + numStr : numStr;
    var label = document.createElement("strong");
    label.textContent = node.label;
    var detail = document.createElement("p");
    detail.textContent = node.detail || "";
    card.appendChild(step);
    card.appendChild(label);
    card.appendChild(detail);
    flowEl.appendChild(card);
  });

  var risksEl = wrapper.querySelector(".blueprint-risks");
  visualPlan.risks.forEach(function (risk) {
    var item = document.createElement("span");
    item.textContent = risk;
    risksEl.appendChild(item);
  });

  extrasEl.appendChild(wrapper);
}

function syntaxHighlightCode(code, ext) {
  var escaped = artifactRenderer.escapeHtml(code);
  if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx") {
    // 顺序很关键：先做关键字/数字（纯文本上替换），再做注释，最后做字符串。
    // 字符串、注释的 <span> 标签里含有 class 等词，若关键字替换跑在后面，
    // 会命中标签本身、把高亮 HTML 撕碎、原样显示出来。
    escaped = escaped
      .replace(/\b(function|const|let|var|return|if|else|for|while|class|import|export|from|async|await|try|catch|throw|new|this|typeof|instanceof)\b/g, '<span class="code-keyword">$1</span>')
      .replace(/\b(true|false|null|undefined)\b/g, '<span class="code-keyword">$1</span>')
      .replace(/(\d+)/g, '<span class="code-number">$1</span>')
      .replace(/(\/\/.*)/g, '<span class="code-comment">$1</span>')
      .replace(/(&quot;[^&]*&quot;|&#39;[^&#39;]*&#39;|`[^`]*`)/g, '<span class="code-string">$1</span>');
  } else if (ext === "html") {
    escaped = escaped
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="code-comment">$1</span>')
      .replace(/(&lt;[\/]?[a-zA-Z][^&]*&gt;)/g, '<span class="code-keyword">$1</span>')
      .replace(/(&quot;[^&]*&quot;)/g, '<span class="code-string">$1</span>');
  } else if (ext === "css") {
    escaped = escaped
      .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="code-comment">$1</span>')
      .replace(/([.#@][a-zA-Z][\w-]*)/g, '<span class="code-variable">$1</span>')
      .replace(/(:[^;{]*;)/g, function (m) {
        return '<span class="code-string">' + m + '</span>';
      })
      .replace(/\b(px|em|rem|%|vh|vw|ms|s|deg|fr)\b/g, '<span class="code-number">$1</span>');
  } else if (ext === "md") {
    escaped = escaped
      .replace(/^(#{1,4}\s.*)$/gm, '<span class="code-keyword">$1</span>')
      .replace(/(\*\*[^*]+\*\*|`[^`]+`)/g, '<span class="code-string">$1</span>');
  }
  return escaped;
}

function getExt(filename) {
  var parts = filename.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function renderCodeViewers() {
  var codeArtifact = getArtifact("code");
  var extrasEl = document.querySelector("#extras-code");
  if (!codeArtifact || !extrasEl) return;

  var oldViewers = extrasEl.querySelector(".win98-viewers-wrap");
  if (oldViewers) oldViewers.remove();

  var changedFiles = codeArtifact.changedFiles || [];
  if (changedFiles.length === 0) return;

  var wrap = document.createElement("div");
  wrap.className = "win98-viewers-wrap";
  wrap.innerHTML = '<div class="visual-plan-header" style="margin-bottom:8px;"><strong>生成代码文件</strong><p>双击代码区域可全选</p></div>';

  var tabBar = document.createElement("div");
  tabBar.className = "win98-viewer__tabs";
  var bodyContainer = document.createElement("div");
  bodyContainer.className = "win98-viewer__body-container";
  var footerEl = document.createElement("div");
  footerEl.className = "win98-viewer__footer";
  footerEl.innerHTML = '<span class="win98-viewer__lang"></span><button class="win98-viewer__copy" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制</button>';

  // Store file contents
  var fileContents = {};
  var activeFile = null;

  changedFiles.forEach(function (filePath) {
    fileContents[filePath] = null; // null = loading

    var tab = document.createElement("span");
    tab.className = "win98-viewer__tab";
    tab.textContent = filePath.replace("target-app/", "");
    tab.title = filePath;
    tab.addEventListener("click", function () {
      switchTab(filePath);
    });
    tabBar.appendChild(tab);
  });

  var viewerOuter = document.createElement("div");
  viewerOuter.className = "win98-viewer";

  var viewerInner = document.createElement("div");
  viewerInner.className = "win98-viewer__inner";

  var body = document.createElement("div");
  body.className = "win98-viewer__body";
  body.innerHTML = '<div class="win98-viewer__empty">正在加载文件…</div>';

  viewerInner.appendChild(tabBar);
  viewerInner.appendChild(body);
  viewerInner.appendChild(footerEl);
  viewerOuter.appendChild(viewerInner);

  // Double-click to select all code
  body.addEventListener("dblclick", function () {
    var range = document.createRange();
    range.selectNodeContents(body.querySelector(".win98-viewer__code") || body);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  // Copy button
  var copyBtn = footerEl.querySelector(".win98-viewer__copy");
  copyBtn.addEventListener("click", function () {
    if (!activeFile || !fileContents[activeFile]) return;
    navigator.clipboard.writeText(fileContents[activeFile]).then(function () {
      copyBtn.textContent = "已复制!";
      setTimeout(function () {
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制';
      }, 1500);
    }).catch(function () {
      copyBtn.textContent = "复制失败";
      setTimeout(function () {
        copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制';
      }, 1500);
    });
  });

  function switchTab(filePath) {
    activeFile = filePath;
    // Update tabs
    tabBar.querySelectorAll(".win98-viewer__tab").forEach(function (t) {
      t.classList.toggle("active", t.textContent === filePath.replace("target-app/", ""));
    });
    // Update body
    var content = fileContents[filePath];
    var ext = getExt(filePath);
    if (content === null) {
      body.innerHTML = '<div class="win98-viewer__empty">加载中…</div>';
    } else {
      var lines = content.split("\n");
      var lineNums = "";
      for (var i = 0; i < lines.length; i++) {
        lineNums += '<span>' + (i + 1) + '</span>';
      }
      body.innerHTML =
        '<div class="win98-viewer__lines">' + lineNums + '</div>' +
        '<code class="win98-viewer__code">' + syntaxHighlightCode(content, ext) + '</code>';
    }
    var lineCount = content === null ? 0 : content.split("\n").length;
    footerEl.querySelector(".win98-viewer__lang").textContent = ext.toUpperCase() + " · " + lineCount + " lines";
  }

  // Fetch all files
  changedFiles.forEach(function (filePath) {
    var url = window.DEVFLOW_API_BASE + "/pipelines/" + pipeline.id + "/workspace/files/" + filePath;
    fetch(url)
      .then(function (res) { return res.text(); })
      .then(function (text) {
        fileContents[filePath] = text;
        if (activeFile === filePath || activeFile === null) {
          if (activeFile === null) activeFile = filePath;
          switchTab(filePath);
        }
      })
      .catch(function () {
        fileContents[filePath] = "// Failed to load: " + filePath;
        if (activeFile === filePath || activeFile === null) {
          if (activeFile === null) activeFile = filePath;
          switchTab(filePath);
        }
      });
  });

  wrap.appendChild(viewerOuter);
  extrasEl.appendChild(wrap);
}

function renderProductPreviewInCodeStage() {
  var codeArtifact = getArtifact("code");
  var extrasEl = document.querySelector("#extras-code");
  if (!codeArtifact || !extrasEl) return;

  var oldPreview = extrasEl.querySelector(".product-preview-inline");
  if (oldPreview) oldPreview.remove();

  var previewUrl = window.DEVFLOW_API_BASE + "/runs/" + pipeline.id + "/target-app/index.html";
  var wrapper = document.createElement("div");
  wrapper.className = "product-preview-inline";
  wrapper.innerHTML =
    '<div class="visual-plan-header">' +
      '<strong>产品预览</strong>' +
      '<button class="ghost-button expand-preview-btn inline-expand-btn" type="button">全屏查看</button>' +
    '</div>' +
    '<div class="product-preview-frame">' +
      '<iframe src="' + previewUrl + '" sandbox="allow-scripts allow-same-origin allow-forms" title="产品预览"></iframe>' +
    '</div>';
  extrasEl.appendChild(wrapper);

  var expandBtn = wrapper.querySelector(".inline-expand-btn");
  var frameWrap = wrapper.querySelector(".product-preview-frame");
  expandBtn.addEventListener("click", function () {
    if (expandedFrameWrap === frameWrap) {
      collapsePreview();
    } else {
      collapsePreview();
      expandPreview(frameWrap);
    }
  });
}

// ── 审批置顶条 + 审批历史时间线 ──

function renderApprovalBar() {
  var stage = getCurrentStage();
  var isWaitingReview = pipeline && pipeline.status === "waiting_review";

  elements.approvalBar.classList.toggle("hidden", !isWaitingReview);
  elements.approvalStageName.textContent = isWaitingReview && stage ? stage.name : "";
  elements.rejectReason.disabled = !isWaitingReview;
  elements.approveButton.disabled = !isWaitingReview;
  elements.rejectButton.disabled = !isWaitingReview;

  elements.reviewPanel.classList.toggle("is-waiting", !!isWaitingReview);
  elements.reviewState.textContent = isWaitingReview
    ? (stage ? stage.name + " 待确认" : "待确认")
    : "暂无待确认";
}

function renderReviewHistory() {
  var history = (pipeline && pipeline.reviewHistory) || [];

  elements.reviewHistoryEmpty.classList.toggle("hidden", history.length > 0);
  elements.reviewHistoryList.innerHTML = history.slice().reverse().map(function (record) {
    var isApprove = record.decision === "approve";
    var time = "";
    try {
      time = new Date(record.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch (_) {}
    return (
      '<li class="review-history-item">' +
        '<span class="review-history-item__icon ' + (isApprove ? "approve" : "reject") + '">' + (isApprove ? "✓" : "✕") + "</span>" +
        '<div class="review-history-item__body">' +
          "<strong>" + artifactRenderer.escapeHtml(record.stageName || "") + " · " + (isApprove ? "通过" : "打回") + "</strong>" +
          (record.reason ? '<div class="review-history-item__reason">' + artifactRenderer.escapeHtml(record.reason) + "</div>" : "") +
        "</div>" +
        '<span class="review-history-item__time">' + time + "</span>" +
      "</li>"
    );
  }).join("");
}

// Show product preview as soon as code is generated (BEFORE delivery stage)
function renderProductPreview() {
  var previewUrl = getProductPreviewUrl();
  var hasPreview = !!(pipeline && getArtifact("code"));
  elements.productPreviewSection.classList.toggle("hidden", !hasPreview);

  if (!hasPreview) {
    elements.productPreviewFrame.removeAttribute("src");
    return;
  }

  elements.productPreviewFrame.src = previewUrl;
  elements.productPreviewLink.href = previewUrl || "#";
  elements.productPreviewLink.classList.toggle("is-disabled", !previewUrl);
}

// Show delivery summary only when pipeline is fully completed.
// 展示 delivery 阶段真正的总结内容（产物正文）+ diff 统计 + 文件清单。
function renderDeliveryPackage() {
  var isComplete = pipeline && pipeline.status === "completed";
  elements.deliveryPackage.classList.toggle("hidden", !isComplete);

  if (!isComplete) return;

  var delivery = getArtifact("delivery");
  var code = getArtifact("code");
  var test = getArtifact("test");

  elements.deliverySummaryBody.innerHTML = delivery && delivery.content
    ? artifactRenderer.renderMarkdown(delivery.content)
    : "<p>交付总结暂未生成。</p>";

  var changedFiles = [];
  if (code && code.changedFiles) changedFiles = changedFiles.concat(code.changedFiles);
  if (test && test.changedFiles) changedFiles = changedFiles.concat(test.changedFiles);
  var uniqueFiles = [];
  changedFiles.forEach(function (f) {
    if (uniqueFiles.indexOf(f) === -1) uniqueFiles.push(f);
  });
  var testFiles = (test && test.changedFiles ? test.changedFiles.length : 0);

  elements.deliveryStats.innerHTML =
    '<div class="delivery-stat"><span>变更文件</span><strong>' + uniqueFiles.length + '</strong></div>' +
    '<div class="delivery-stat"><span>其中测试文件</span><strong>' + testFiles + '</strong></div>' +
    '<div class="delivery-stat"><span>完成阶段</span><strong>' + Object.keys(pipeline.artifacts).length + " / " + getStages().length + '</strong></div>';

  elements.deliveryFiles.replaceChildren.apply(
    elements.deliveryFiles,
    uniqueFiles.map(function (file) {
      var item = document.createElement("li");
      item.textContent = file;
      return item;
    })
  );
}

function renderWorkspace() {
  if (!pipeline) {
    elements.workspaceFileCount.textContent = "0 个文件";
    elements.workspacePath.textContent = "";
    elements.exportWorkspaceLink.href = "#";
    elements.workspaceEmpty.classList.remove("hidden");
    elements.workspaceFileList.querySelectorAll(".workspace-file-item").forEach(function (el) { el.remove(); });
    return;
  }

  var completedIds = Object.keys(pipeline.artifacts);
  if (completedIds.length === 0) {
    elements.workspaceFileCount.textContent = "0 个文件";
    elements.workspacePath.textContent = "";
    elements.exportWorkspaceLink.href = "#";
    elements.workspaceEmpty.classList.remove("hidden");
    elements.workspaceFileList.querySelectorAll(".workspace-file-item").forEach(function (el) { el.remove(); });
    elements.codeSearch.classList.add("hidden");
    return;
  }

  var hasCode = !!getArtifact("code");
  elements.codeSearch.classList.toggle("hidden", !hasCode);

  elements.exportWorkspaceLink.href =
    window.DEVFLOW_API_BASE + "/pipelines/" + pipeline.id + "/workspace/export";

  fetch(window.DEVFLOW_API_BASE + "/pipelines/" + pipeline.id + "/workspace")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var files = data.files || [];
      elements.workspaceFileCount.textContent = files.length + " 个文件";
      elements.workspacePath.textContent = data.path || "";

      // Git status
      if (data.git) {
        elements.workspaceGit.classList.remove("hidden");
        elements.gitBranch.textContent = data.git.branch || "";
        elements.gitCommit.textContent = data.git.commit || "";
        if (data.git.log) {
          elements.gitCommit.title = data.git.log;
        }
      } else {
        elements.workspaceGit.classList.add("hidden");
      }

      if (files.length === 0) {
        elements.workspaceEmpty.classList.remove("hidden");
        elements.workspaceFileList.querySelectorAll(".workspace-file-item").forEach(function (el) { el.remove(); });
        return;
      }

      elements.workspaceEmpty.classList.add("hidden");

      var existingItems = {};
      elements.workspaceFileList.querySelectorAll(".workspace-file-item").forEach(function (el) {
        existingItems[el.dataset.filename] = el;
      });

      files.forEach(function (file) {
        var name = file.name;
        var size = file.size < 1024
          ? file.size + " B"
          : file.size < 1024 * 1024
            ? (file.size / 1024).toFixed(1) + " KB"
            : (file.size / (1024 * 1024)).toFixed(1) + " MB";

        if (existingItems[name]) {
          var sizeEl = existingItems[name].querySelector(".file-size");
          if (sizeEl) sizeEl.textContent = size;
          delete existingItems[name];
          return;
        }

        var item = document.createElement("div");
        item.className = "workspace-file-item";
        item.dataset.filename = name;
        item.title = "点击预览文件";

        var icon = document.createElement("span");
        icon.className = "file-icon";
        var ext = name.split(".").pop().toLowerCase();
        icon.textContent = ext.slice(0, 4).toUpperCase();
        icon.dataset.ext = ext;

        var info = document.createElement("div");
        info.className = "file-info";

        var fileName = document.createElement("span");
        fileName.className = "file-name";
        fileName.textContent = name;

        var fileSize = document.createElement("span");
        fileSize.className = "file-size";
        fileSize.textContent = size;

        info.appendChild(fileName);
        info.appendChild(fileSize);

        var preview = document.createElement("a");
        preview.className = "file-link";
        preview.href = window.DEVFLOW_API_BASE + "/pipelines/" + pipeline.id + "/workspace/files/" + name;
        preview.target = "_blank";
        preview.textContent = "打开";

        item.appendChild(icon);
        item.appendChild(info);
        item.appendChild(preview);
        elements.workspaceFileList.appendChild(item);
      });

      Object.keys(existingItems).forEach(function (name) {
        existingItems[name].remove();
      });
    })
    .catch(function () {
      // Workspace not ready yet
    });
}

function render() {
  setStatusBadge();
  renderStages();
  renderArtifact();
  renderApprovalBar();
  renderReviewHistory();
  renderWorkspace();
  renderProductPreview();
  renderDeliveryPackage();
}

// ── API actions ──

async function checkHealth() {
  try {
    await client.health();
    return true;
  } catch (_e) {
    return false;
  }
}

async function runUntilReviewOrComplete() {
  if (!pipeline) return;
  isRunning = true;
  runErrorMessage = "";
  abortController = new AbortController();
  var stage = getCurrentStage();
  runningStageName = stage ? stage.name : "";
  render();

  try {
    await connectLiveOutput(pipeline.id);
    pipeline = await client.getPipeline(pipeline.id);
  } catch (error) {
    // 同一 pipeline 已在运行时，后端返回 409：如实告诉用户，而不是笼统报错。
    if (error && error.status === 409) {
      runErrorMessage = "该流程已在运行中（409），请等它结束后再试";
    } else {
      runErrorMessage = error.message || "执行失败";
    }
    if (error.message) {
      appendErrorMessage(runErrorMessage);
    }
  } finally {
    isRunning = false;
    abortController = null;
    runningStageName = "";
    disconnectLiveOutput();
    render();
    // 这一轮跑完了：终端收起为一行摘要，产物面板展示最终产物。
    if (!runErrorMessage) collapseLiveOutput();
  }
}

// ── 历史运行：刷新恢复 + 列表切换 ──

async function restoreLastPipeline() {
  var id = loadLastPipelineId();
  if (!id) return false;
  try {
    var restored = await client.getPipeline(id);
    if (restored && restored.id) {
      pipeline = restored;
      render();
      return true;
    }
  } catch (_) {
    // 后端不可用或该运行已被删除：静默降级，不报错、不挡页面。
  }
  return false;
}

function formatHistoryStatus(status) {
  var map = {
    ready: "就绪",
    running: "运行中",
    waiting_review: "待审批",
    failed: "失败",
    completed: "已完成",
  };
  return map[status] || status || "未知";
}

async function loadHistoryList() {
  elements.historyList.innerHTML = '<div class="history-loading">加载中…</div>';
  try {
    var list = await client.listPipelines();
    if (!Array.isArray(list) || list.length === 0) {
      elements.historyList.innerHTML = '<div class="history-empty">暂无历史运行</div>';
      return;
    }
    elements.historyList.innerHTML = "";
    list.forEach(function (item) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "history-item";
      var name = (item.name || item.requirement || item.id || "").trim();
      if (name.length > 28) name = name.slice(0, 28) + "…";
      var updated = "";
      try {
        updated = item.updated_at ? new Date(item.updated_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      } catch (_) {}
      var stageName = "";
      if (item.current_stage) {
        var found = STAGES.filter(function (s) { return s.id === item.current_stage; })[0];
        stageName = found ? found.name : item.current_stage;
      }
      button.innerHTML =
        '<span class="history-item__name">' + artifactRenderer.escapeHtml(name) + "</span>" +
        '<span class="history-item__meta">' +
          '<span class="history-item__status st-' + artifactRenderer.escapeHtml(item.status || "") + '">' + formatHistoryStatus(item.status) + "</span>" +
          (stageName ? "<span>" + artifactRenderer.escapeHtml(stageName) + "</span>" : "") +
          (updated ? "<span>" + updated + "</span>" : "") +
        "</span>";
      button.addEventListener("click", function () {
        loadPipelineById(item.id);
      });
      elements.historyList.appendChild(button);
    });
  } catch (_) {
    // GET /pipelines 暂不可用（旧后端 / 演示回放）：优雅降级，只恢复本地 id。
    elements.historyList.innerHTML = '<div class="history-empty">历史记录暂不可用（需要后端支持 GET /pipelines）</div>';
  }
}

async function loadPipelineById(id) {
  try {
    var restored = await client.getPipeline(id);
    if (restored && restored.id) {
      pipeline = restored;
      saveLastPipelineId(id);
      userToggledSections = {};
      clearLiveArchives();
      closeHistoryPanel();
      render();
    }
  } catch (error) {
    runErrorMessage = error.message || "加载失败";
    render();
  }
}

function openHistoryPanel() {
  elements.historyPanel.classList.remove("hidden");
  loadHistoryList();
}

function closeHistoryPanel() {
  elements.historyPanel.classList.add("hidden");
}

function openClarificationModal(requirement) {
  pendingRequirement = requirement;
  pendingTemplate = elements.templateSelector ? elements.templateSelector.value : "feature";
  clarificationStepIndex = 0;
  clarificationAnswers = {};
  elements.clarificationRequirement.textContent = requirement;
  elements.clarificationModal.classList.remove("hidden");
  renderClarificationStep();
}

function closeClarificationModal() {
  elements.clarificationModal.classList.add("hidden");
  clarificationStepIndex = 0;
  clarificationAnswers = {};
}

function renderClarificationDots() {
  var questions = clarificationFlow.getClarificationQuestions(pendingRequirement);
  elements.clarificationDots.innerHTML = questions.map(function (_, index) {
    var cls = "dot";
    if (index < clarificationStepIndex) cls += " done";
    if (index === clarificationStepIndex) cls += " active";
    return '<span class="' + cls + '"></span>';
  }).join("");
}

function renderClarificationStep() {
  var questions = clarificationFlow.getClarificationQuestions(pendingRequirement);
  var total = questions.length;
  var question = questions[clarificationStepIndex];

  elements.clarificationProgress.textContent = (clarificationStepIndex + 1) + " / " + total;
  elements.clarificationStepLabel.textContent = question.label;
  elements.clarificationStepQuestion.textContent = question.question;
  elements.clarificationStepAnswer.placeholder = question.placeholder;
  elements.clarificationStepAnswer.value = clarificationAnswers[question.id] || "";

  // 动态问题没有放之四海皆准的推荐答案：没有 recommended 就隐藏该按钮。
  if (question.recommended) {
    elements.clarificationStepHint.textContent = "推荐：" + question.recommended;
    elements.clarificationRecommend.classList.remove("hidden");
  } else {
    elements.clarificationStepHint.textContent = "想到什么写什么，也可以留空。";
    elements.clarificationRecommend.classList.add("hidden");
  }

  var isLast = clarificationStepIndex === total - 1;
  var isFirst = clarificationStepIndex === 0;

  elements.clarificationPrev.classList.toggle("hidden", isFirst);
  elements.clarificationNext.textContent = isLast ? "提交回答并生成 PRD" : "下一题";
  elements.clarificationNext.type = "button";
  elements.clarificationNext.classList.toggle("primary-button", true);
  elements.clarificationNext.classList.toggle("secondary-button", !isLast);
  elements.clarificationRecommend.textContent = "使用推荐回答";

  renderClarificationDots();
  elements.clarificationStepAnswer.focus();
}

function collectClarificationAnswers() {
  return clarificationAnswers;
}

async function startPipeline(requirement, projectPath, template) {
  runErrorMessage = "";
  abortController = new AbortController();
  isRunning = true;
  runningStageName = "创建 Pipeline";
  try {
    render();
  } catch (e) {
    console.error("[startPipeline] render threw:", e);
  }

  try {
    pipeline = await client.createPipeline(requirement, projectPath, template);
    saveLastPipelineId(pipeline.id);
    userToggledSections = {};
    clearLiveArchives();
  } catch (error) {
    runErrorMessage = error.message;
    isRunning = false;
    abortController = null;
    runningStageName = "";
    render();
    return;
  }

  isRunning = false;
  abortController = null;
  runningStageName = "";
  elements.rejectReason.value = "";
  await runUntilReviewOrComplete();
}

// ── Event listeners ──

elements.form.addEventListener("submit", async function (event) {
  event.preventDefault();
  var requirement = elements.requirementInput.value.trim();
  var template = elements.templateSelector ? elements.templateSelector.value : "feature";
  if (!requirement) {
    await startPipeline(requirement, "", template);
    return;
  }
  if (clarificationFlow.shouldAskClarification(requirement)) {
    openClarificationModal(requirement);
    return;
  }
  await startPipeline(requirement, "", template);
});

async function approveCurrentStage() {
  if (!pipeline) return;
  try {
    pipeline = await client.submitReview(pipeline.id, "approve");
    elements.rejectReason.value = "";
    await runUntilReviewOrComplete();
  } catch (error) {
    runErrorMessage = error.message;
    render();
  }
}

elements.approveButton.addEventListener("click", approveCurrentStage);

async function rejectCurrentStage(reasonElement) {
  if (!pipeline) return;
  try {
    pipeline = await client.submitReview(pipeline.id, "reject", reasonElement.value);
    elements.rejectReason.value = "";
    // 打回后不清空实时输出：上一轮输出折叠归档，留着备查。
    archiveLiveOutput();
    render();
    await runUntilReviewOrComplete();
  } catch (error) {
    reasonElement.focus();
    reasonElement.placeholder = error.message;
  }
}

elements.rejectButton.addEventListener("click", function () {
  rejectCurrentStage(elements.rejectReason);
});

elements.liveOutputExpandBtn.addEventListener("click", expandLiveOutput);

elements.historyButton.addEventListener("click", function () {
  if (elements.historyPanel.classList.contains("hidden")) {
    openHistoryPanel();
  } else {
    closeHistoryPanel();
  }
});

elements.historyClose.addEventListener("click", closeHistoryPanel);

document.addEventListener("click", function (event) {
  if (elements.historyPanel.classList.contains("hidden")) return;
  if (elements.historyPanel.contains(event.target)) return;
  if (elements.historyButton.contains(event.target)) return;
  closeHistoryPanel();
});

elements.clarificationCancel.addEventListener("click", function () {
  pendingRequirement = "";
  closeClarificationModal();
});

// 跳过澄清：直接用原始需求生成，不往 PRD 里掺任何模板答案。
elements.clarificationSkip.addEventListener("click", function () {
  var requirement = pendingRequirement;
  var template = pendingTemplate;
  closeClarificationModal();
  startPipeline(requirement, "", template);
});

elements.clarificationRecommend.addEventListener("click", function () {
  var questions = clarificationFlow.getClarificationQuestions(pendingRequirement);
  var question = questions[clarificationStepIndex];
  if (!question.recommended) return;
  elements.clarificationStepAnswer.value = question.recommended;
  clarificationAnswers[question.id] = question.recommended;
});

elements.clarificationPrev.addEventListener("click", function () {
  var questions = clarificationFlow.getClarificationQuestions(pendingRequirement);
  // Save current answer
  var question = questions[clarificationStepIndex];
  var value = elements.clarificationStepAnswer.value.trim();
  if (value) clarificationAnswers[question.id] = value;

  if (clarificationStepIndex > 0) {
    clarificationStepIndex -= 1;
    renderClarificationStep();
  }
});

elements.clarificationNext.addEventListener("click", function () {
  submitClarification();
});

elements.clarificationForm.addEventListener("submit", function (event) {
  event.preventDefault();
  submitClarification();
});

elements.clarificationStepAnswer.addEventListener("keydown", function (event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitClarification();
  }
});

function submitClarification() {
  var questions = clarificationFlow.getClarificationQuestions(pendingRequirement);
  var total = questions.length;

  // Save current step answer
  var question = questions[clarificationStepIndex];
  var value = elements.clarificationStepAnswer.value.trim();
  if (value) clarificationAnswers[question.id] = value;

  // If not on last step, advance
  if (clarificationStepIndex < total - 1) {
    clarificationStepIndex += 1;
    renderClarificationStep();
    return;
  }

  // Final step: 只合并用户真正答了的内容；一道没答就直接用原始需求，
  // 不再用推荐答案自动填空。
  var enrichedRequirement = clarificationFlow.mergeClarificationAnswers(
    pendingRequirement,
    clarificationAnswers
  );
  closeClarificationModal();
  startPipeline(enrichedRequirement, "", pendingTemplate);
}

// ── Preview expand/collapse ──

var expandedFrameWrap = null;
var backdropEl = null;

function createBackdrop() {
  if (backdropEl) return;
  backdropEl = document.createElement("div");
  backdropEl.className = "preview-backdrop";
  backdropEl.addEventListener("click", collapsePreview);
  document.body.appendChild(backdropEl);
}

function removeBackdrop() {
  if (backdropEl) {
    backdropEl.remove();
    backdropEl = null;
  }
}

function expandPreview(frameWrap) {
  createBackdrop();
  frameWrap.classList.add("is-expanded");
  expandedFrameWrap = frameWrap;
}

function collapsePreview() {
  if (expandedFrameWrap) {
    expandedFrameWrap.classList.remove("is-expanded");
    expandedFrameWrap = null;
  }
  removeBackdrop();
}

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && expandedFrameWrap) {
    collapsePreview();
  }
});

elements.productExpandBtn.addEventListener("click", function () {
  if (expandedFrameWrap === elements.productFrameWrap) {
    collapsePreview();
  } else {
    collapsePreview();
    expandPreview(elements.productFrameWrap);
  }
});

// ── Code Search ──

var searchDebounceTimer = null;

function performCodeSearch(query) {
  if (!pipeline || !query.trim()) {
    elements.codeSearchResults.classList.add("hidden");
    elements.codeSearchResults.innerHTML = "";
    return;
  }

  var url = window.DEVFLOW_API_BASE + "/pipelines/" + pipeline.id + "/code-search?q=" + encodeURIComponent(query) + "&type=symbol";
  fetch(url)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var results = data.results || [];
      if (results.length === 0) {
        elements.codeSearchResults.classList.remove("hidden");
        elements.codeSearchResults.innerHTML = '<div class="code-search-empty">未找到匹配的符号</div>';
        return;
      }
      elements.codeSearchResults.classList.remove("hidden");
      var kindClassMap = {
        "function": "kind-function",
        "class": "kind-class",
        "html_element": "kind-html_element",
        "css_rule": "kind-css_rule",
        "event": "kind-event",
      };
      elements.codeSearchResults.innerHTML = results.map(function (r) {
        var kindClass = kindClassMap[r.kind] || "";
        return (
          '<div class="code-search-result-item" title="' + r.file + ':' + r.line + '">' +
            '<span class="code-search-kind ' + kindClass + '">' + r.kind + '</span>' +
            '<div>' +
              '<span class="code-search-name">' + artifactRenderer.escapeHtml(r.name) + '</span>' +
              ' <span class="code-search-file">' + r.file + ':' + r.line + '</span>' +
              '<div class="code-search-snippet">' + artifactRenderer.escapeHtml(r.snippet || "") + '</div>' +
            '</div>' +
          '</div>'
        );
      }).join("");
    })
    .catch(function () {
      elements.codeSearchResults.classList.add("hidden");
    });
}

elements.codeSearchInput.addEventListener("input", function () {
  clearTimeout(searchDebounceTimer);
  var query = elements.codeSearchInput.value;
  searchDebounceTimer = setTimeout(function () {
    performCodeSearch(query);
  }, 250);
});

elements.resetButton.addEventListener("click", function () {
  pipeline = null;
  runErrorMessage = "";
  pendingRequirement = "";
  userToggledSections = {};
  clearLastPipelineId();
  disconnectLiveOutput();
  hideLiveOutput();
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  elements.rejectReason.value = "";
  render();
});

// On load, show initial state, restore the last pipeline if any, and check backend health
render();
restoreLastPipeline();

// Validate all critical element references
(function validateElements() {
  var criticalIds = [
    "requirementInput", "clarificationNext", "clarificationStepAnswer",
    "clarificationModal", "clarificationForm", "requestForm", "liveOutputStream",
    "pipelineStatus", "approveButton", "rejectButton"
  ];
  criticalIds.forEach(function (id) {
    var el = document.querySelector("#" + id);
    if (el) {
      console.log("[validate] #" + id + " ✓");
    } else {
      console.error("[validate] #" + id + " ✗ NOT FOUND");
    }
  });
  console.log("[validate] elements.requirementInput:", elements.requirementInput);
  console.log("[validate] elements.clarificationNext:", elements.clarificationNext);
  console.log("[validate] elements.clarificationStepAnswer:", elements.clarificationStepAnswer);
  console.log("[validate] elements.form:", elements.form);
})();

checkHealth().then(function (healthy) {
  if (healthy) {
    console.log("DevFlow Engine 后端已连接。");
  } else {
    console.warn("DevFlow Engine 后端未连接。请启动后端：uvicorn backend.main:app --reload");
  }
});

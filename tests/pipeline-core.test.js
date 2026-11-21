var assert = require("node:assert/strict");
var {
  STAGES,
  STAGE_STATES,
  STAGE_STATE_LABELS,
  createClient,
  resolveStageState,
  extractArtifactSummary,
  parseReviewVerdict,
} = require("../pipeline-core");

// STAGES definition must be valid
assert.equal(STAGES.length, 6, "should have 6 stages");
assert.equal(STAGES[0].id, "requirement");
assert.equal(STAGES[0].name, "需求分析");
assert.equal(STAGES[0].approvalRequired, true, "requirement should require approval");
assert.equal(STAGES[1].id, "design");
assert.equal(STAGES[1].approvalRequired, true, "design should require approval");
assert.equal(STAGES[2].id, "code");
assert.equal(STAGES[2].approvalRequired, true, "code should require approval");
assert.equal(STAGES[3].id, "test");
assert.equal(STAGES[3].approvalRequired, true, "test should require approval");
assert.equal(STAGES[4].id, "review");
assert.equal(STAGES[4].approvalRequired, true, "review should require approval");
assert.equal(STAGES[5].id, "delivery");
assert.equal(STAGES[5].approvalRequired, true, "delivery should require approval");

// Each stage must have required fields
STAGES.forEach(function (stage, index) {
  assert.ok(stage.id, "stage " + index + " missing id");
  assert.ok(stage.name, "stage " + index + " missing name");
  assert.ok(stage.agent, "stage " + index + " missing agent");
  assert.equal(typeof stage.approvalRequired, "boolean", "stage " + index + " approvalRequired must be boolean");
});

// Approval checkpoints: every stage should stop for human review
var approvalStages = STAGES.filter(function (s) { return s.approvalRequired; });
assert.equal(approvalStages.length, STAGES.length, "every stage must have a human-in-the-loop checkpoint");
assert.deepEqual(approvalStages.map(function (s) { return s.id; }), STAGES.map(function (s) { return s.id; }));

// Five visually distinct stage states
assert.deepEqual(STAGE_STATES, ["pending", "running", "waiting_review", "complete", "failed"]);
assert.equal(STAGE_STATE_LABELS.waiting_review, "待你审批");
assert.equal(STAGE_STATE_LABELS.failed, "失败");

// createClient must return an API client with expected methods
var client = createClient("http://127.0.0.1:8000");
assert.equal(typeof client.health, "function");
assert.equal(typeof client.createPipeline, "function");
assert.equal(typeof client.getPipeline, "function");
assert.equal(typeof client.listPipelines, "function");
assert.equal(typeof client.runUntilReview, "function");
assert.equal(typeof client.runNext, "function");
assert.equal(typeof client.submitReview, "function");

// createClient should strip trailing slashes from base URL
var trimmedClient = createClient("http://example.com/api/");
assert.ok(trimmedClient);

// Export nothing extra beyond the documented API
var exported = require("../pipeline-core");
assert.ok(exported.STAGES);
assert.ok(exported.createClient);
assert.ok(exported.resolveStageState);
assert.ok(exported.extractArtifactSummary);
assert.ok(exported.parseReviewVerdict);
assert.equal(Object.keys(exported).length, 7, "should only export the documented core API");

// ── resolveStageState ──

function fakePipeline(overrides) {
  return Object.assign(
    { status: "ready", currentStageId: "requirement", artifacts: {}, failed_stage: null },
    overrides
  );
}

// No pipeline at all → everything pending
assert.equal(resolveStageState("code", null), "pending");

// Idle ready: current stage without artifact is pending, NOT running
assert.equal(resolveStageState("requirement", fakePipeline({})), "pending");
assert.equal(resolveStageState("design", fakePipeline({})), "pending");

// Running: only the current stage runs
assert.equal(
  resolveStageState("code", fakePipeline({ status: "running", currentStageId: "code", artifacts: { requirement: {}, design: {} } })),
  "running"
);
assert.equal(
  resolveStageState("requirement", fakePipeline({ status: "running", currentStageId: "code", artifacts: { requirement: {}, design: {} } })),
  "complete"
);

// THE key rule: a stage with an artifact that is waiting for review must
// show as waiting_review, never as complete.
assert.equal(
  resolveStageState(
    "design",
    fakePipeline({ status: "waiting_review", currentStageId: "design", artifacts: { requirement: {}, design: {} } })
  ),
  "waiting_review",
  "waiting_review with artifact must not be complete"
);
// Earlier stages with artifacts stay complete while a later one waits.
assert.equal(
  resolveStageState(
    "requirement",
    fakePipeline({ status: "waiting_review", currentStageId: "design", artifacts: { requirement: {}, design: {} } })
  ),
  "complete"
);

// Completed pipeline: every stage complete
assert.equal(
  resolveStageState(
    "delivery",
    fakePipeline({ status: "completed", currentStageId: "delivery", artifacts: { requirement: {}, design: {}, code: {}, test: {}, review: {}, delivery: {} } })
  ),
  "complete"
);

// Failed: the failed stage is failed (even with a partial artifact),
// earlier stages with artifacts stay complete, later ones pending.
var failed = fakePipeline({
  status: "failed",
  currentStageId: "code",
  failed_stage: "code",
  failure_reason: "LLM 超时",
  artifacts: { requirement: {}, design: {}, code: {} },
});
assert.equal(resolveStageState("code", failed), "failed");
assert.equal(resolveStageState("design", failed), "complete");
assert.equal(resolveStageState("test", failed), "pending");
// Failed without a named stage: the current stage is the failed one.
assert.equal(
  resolveStageState("code", fakePipeline({ status: "failed", currentStageId: "code", failed_stage: null })),
  "failed"
);
// API serializes camelCase (failedStage/failureReason): same outcome.
assert.equal(
  resolveStageState(
    "code",
    fakePipeline({ status: "failed", currentStageId: "code", failedStage: "code", failureReason: "LLM 超时", artifacts: { requirement: {}, design: {}, code: {} } })
  ),
  "failed"
);

// ── extractArtifactSummary ──

var designMd = [
  "# 技术方案：CSS 变量 + data-theme",
  "",
  "## 现状",
  "`target-app` 是一个静态页面：`index.html`、`styles.css`、`app.js`，颜色直接写死在样式里。",
  "",
  "## 方案",
  "1. 把所有颜色抽成 `:root` 上的 CSS 变量，新增 `:root[data-theme=\"dark\"]` 覆盖一套暗色值",
  "2. 在 `<head>` 里用一小段内联脚本，在首帧渲染前决定主题，避免闪白",
  "",
  "## 改动文件",
  "| 文件 | 改动 |",
  "| --- | --- |",
  "| `target-app/index.html` | 新增开关按钮和首帧主题脚本 |",
  "| `target-app/styles.css` | 颜色改为变量，新增暗色变量和开关样式 |",
  "| `target-app/app.js` | 新增主题切换与持久化逻辑 |",
  "",
  "## 风险",
  "- 首帧闪白：用内联脚本在样式加载前设置 `data-theme`",
  "- 对比度不足：暗色文字与背景对比度不低于 4.5:1",
].join("\n");

var summary = extractArtifactSummary(designMd);
assert.equal(summary.points.length, 3, "should extract 3 key points");
assert.ok(summary.points.some(function (p) { return p.indexOf("现状") !== -1; }));
assert.ok(summary.files.indexOf("target-app/index.html") !== -1, "should extract changed files");
assert.ok(summary.files.indexOf("target-app/styles.css") !== -1);
assert.ok(summary.files.indexOf("target-app/app.js") !== -1);
assert.equal(summary.risks.length, 2, "should extract risks");
assert.ok(summary.risks[0].indexOf("首帧闪白") !== -1);

// No headings / risks at all: fall back to the first lines, empty risks.
var plain = extractArtifactSummary("做了两件事。\n\n第二段说明。\n\n第三段说明。");
assert.ok(plain.points.length >= 1, "fallback to first lines when nothing structured");
assert.deepEqual(plain.files, []);
assert.deepEqual(plain.risks, []);
assert.deepEqual(extractArtifactSummary("").points, []);

// Code fences must not leak into points/files
var fenced = extractArtifactSummary("```js\nconst a = require('x.js');\n```\n\n## 结论\n\n- 真正的要点");
assert.ok(fenced.files.indexOf("x.js") === -1, "paths inside code fences are not files");
assert.ok(fenced.points.some(function (p) { return p.indexOf("真正的要点") !== -1; }));

// ── parseReviewVerdict ──

var verdictMd = [
  "# 代码评审",
  "",
  "```json",
  JSON.stringify({ verdict: "reject", issues: ["开关初始 aria-checked 未同步", "缺少空状态处理"] }),
  "```",
  "",
  "## 正确性审查：不通过",
  "- 首帧脚本与 app.js 读取同一个 key",
].join("\n");

var verdict = parseReviewVerdict(verdictMd);
assert.ok(verdict, "should detect the verdict JSON block");
assert.equal(verdict.verdict, "reject");
assert.deepEqual(verdict.issues, ["开关初始 aria-checked 未同步", "缺少空状态处理"]);

var passMd = "评审完成。\n\n```json\n" + JSON.stringify({ verdict: "pass", issues: [] }) + "\n```";
assert.equal(parseReviewVerdict(passMd).verdict, "pass");
assert.deepEqual(parseReviewVerdict(passMd).issues, []);

assert.equal(parseReviewVerdict("# 评审\n\n没有结构化结论，只有正文。"), null);
assert.equal(parseReviewVerdict("```json\n{\"verdict\": \"maybe\"}\n```"), null);

console.log("pipeline-core tests passed");

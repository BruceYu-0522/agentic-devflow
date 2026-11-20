// DevFlow 在线演示：没有后端时，在浏览器里模拟 API 与流式输出。
// 回放一次预先生成的示例运行（需求：给任务管理应用增加暗色模式）。
// 代码阶段产出的页面和测试文件是真实可运行的，放在 demo-api/ 目录下。
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var isLocal = ["localhost", "127.0.0.1"].indexOf(location.hostname) !== -1;
  var DEMO = params.get("demo") === "1" || (params.get("demo") !== "0" && !isLocal && !window.DEVFLOW_API_BASE);
  window.DEVFLOW_DEMO = DEMO;
  if (!DEMO) return;

  var BASE = "/demo-api";
  window.DEVFLOW_API_BASE = BASE;
  var DEMO_REQUIREMENT = "给任务管理应用增加暗色模式：右上角有开关，默认跟随系统，记住用户的选择。";
  window.DEVFLOW_DEMO_REQUIREMENT = DEMO_REQUIREMENT;
  var MODEL = "演示回放";

  var SKILLS = {
    requirement: "requirements-analysis",
    design: "technical-design",
    code: "code-change",
    test: "test-generation",
    review: "code-review",
    delivery: "delivery-summary",
  };
  var STAGES = [
    ["requirement", "需求分析", "需求分析 Agent"],
    ["design", "方案设计", "方案设计 Agent"],
    ["code", "代码生成", "代码生成 Agent"],
    ["test", "测试生成", "测试生成 Agent"],
    ["review", "代码评审", "代码评审 Agent"],
    ["delivery", "交付总结", "交付总结 Agent"],
  ].map(function (s) {
    return {
      id: s[0], name: s[1], agent: s[2], approvalRequired: true,
      skill: { id: SKILLS[s[0]], name: s[2], path: "skills/" + SKILLS[s[0]] + ".skill.md" },
    };
  });

  /* ---------------- 各阶段产物 ---------------- */

  var PROTOTYPE = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f3f4f6;display:flex;gap:18px;padding:22px;justify-content:center}' +
    '.card{width:260px;border:2px dashed #9aa3af;border-radius:14px;padding:16px;background:#fff}' +
    '.card.dark{background:#1f2329;color:#e6e8eb;border-color:#4b5563}' +
    '.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}' +
    '.sw{width:40px;height:22px;border-radius:11px;border:2px dashed currentColor;position:relative}' +
    '.sw i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:currentColor}' +
    '.dark .sw i{left:20px}.row{height:30px;border:2px dashed #c7cdd6;border-radius:8px;margin-bottom:8px}' +
    '.dark .row{border-color:#4b5563}.lbl{font-size:12px;color:#6b7280;margin-top:10px;text-align:center}' +
    '</style></head><body>' +
    '<div><div class="card"><div class="top"><b>任务管理</b><span class="sw"><i></i></span></div><div class="row"></div><div class="row"></div><div class="row"></div></div><div class="lbl">浅色（默认跟随系统）</div></div>' +
    '<div><div class="card dark"><div class="top"><b>任务管理</b><span class="sw"><i></i></span></div><div class="row"></div><div class="row"></div><div class="row"></div></div><div class="lbl">暗色：点右上角开关切换</div></div>' +
    '</body></html>';

  var CONTENT = {
    requirement: [
      "# 需求分析：任务管理应用暗色模式",
      "",
      "## 需求目标",
      "晚上或弱光环境下使用任务管理页面时，大面积白底刺眼。提供暗色模式，让用户在不同环境下都能舒适地查看任务。",
      "",
      "## 目标用户",
      "- 经常在晚上整理任务的个人用户",
      "- 系统已开启深色外观、希望应用自动跟随的用户",
      "",
      "## 本次包含（Must-have）",
      "- 页面右上角一个明暗切换开关",
      "- 首次打开时跟随系统的深浅色设置",
      "- 记住用户手动选择，刷新后保持",
      "- 所有颜色改为主题变量，暗色下对比度满足可读性要求",
      "",
      "## 本次不包含",
      "- 多套主题色、自定义配色",
      "- 按时间自动切换",
      "",
      "## 原型说明",
      "标题右侧放一个开关，浅色与暗色两套状态见下方低保真原型。切换时颜色平滑过渡 0.25 秒，首屏不出现闪白。",
      "",
      "## 验收标准",
      "- Given 系统为深色外观，When 首次打开页面，Then 页面显示暗色",
      "- Given 页面为浅色，When 点击开关，Then 切换为暗色且开关状态同步",
      "- Given 用户选择过暗色，When 刷新页面，Then 仍为暗色",
      "- 已完成任务在两种主题下都能清楚区分",
      "",
      "## 待澄清",
      "- 是否需要在设置页提供同样的选项（本次先不做）",
    ].join("\n"),
    design: [
      "# 技术方案：CSS 变量 + data-theme",
      "",
      "## 现状",
      "`target-app` 是一个静态页面：`index.html`、`styles.css`、`app.js`，颜色直接写死在样式里。",
      "",
      "## 方案",
      "1. 把所有颜色抽成 `:root` 上的 CSS 变量，新增 `:root[data-theme=\"dark\"]` 覆盖一套暗色值",
      "2. 在 `<head>` 里用一小段内联脚本，在首帧渲染前决定主题（已保存的选择 > 系统设置），避免闪白",
      "3. `app.js` 新增 `applyTheme` / `toggleTheme`，开关用 `role=\"switch\"` 和 `aria-checked` 表达状态",
      "4. 选择写入 `localStorage`，写入失败（隐私模式）时不影响切换",
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
    ].join("\n"),
    code: [
      "# 代码变更",
      "",
      "已修改 3 个文件，改动保存在运行工作区，可在下方查看代码和产品预览。",
      "",
      "- `target-app/index.html`：标题区改为左右布局，右侧新增 `#themeToggle` 开关；`<head>` 新增首帧主题脚本",
      "- `target-app/styles.css`：10 个颜色变量，`[data-theme=\"dark\"]` 覆盖暗色；开关滑块动画；尊重“减弱动态效果”",
      "- `target-app/app.js`：`applyTheme`、`toggleTheme`，选择写入 `localStorage`",
      "",
      "```js",
      "function toggleTheme() {",
      "  const next = document.documentElement.dataset.theme === \"dark\" ? \"light\" : \"dark\";",
      "  applyTheme(next);",
      "  try {",
      "    localStorage.setItem(THEME_KEY, next);",
      "  } catch (_error) {}",
      "}",
      "```",
    ].join("\n"),
    test: [
      "# 测试生成",
      "",
      "新增 `tests/theme.test.js`，使用 `node --test` + jsdom，共 6 个用例：",
      "",
      "| 用例 | 覆盖的验收标准 |",
      "| --- | --- |",
      "| 系统为浅色时显示浅色 | 默认跟随系统 |",
      "| 系统为暗色时显示暗色 | 默认跟随系统 |",
      "| 点击开关切换主题并更新 aria-checked | 手动切换、开关状态同步 |",
      "| 选择会被记住 | 刷新后保持 |",
      "| 已保存的选择优先于系统设置 | 记住用户选择 |",
      "| 任务列表照常渲染 | 回归：原有功能不受影响 |",
      "",
      "运行方式：`node --test tests/theme.test.js`",
    ].join("\n"),
    review: [
      "# 代码评审（3 个审查 Agent 并行）",
      "",
      "## 正确性审查：通过",
      "- 首帧脚本与 `app.js` 读取同一个 key，主题判断一致",
      "- 第 1 轮发现开关初始 `aria-checked` 未同步，已自动打回修复（见实时输出），第 2 轮通过",
      "",
      "## 安全性审查：通过",
      "- 只读写 `localStorage` 中的主题值，没有拼接 HTML，不引入外部资源",
      "",
      "## 规范性审查：通过",
      "- 颜色全部来自变量，没有残留写死的颜色",
      "- 动画尊重 `prefers-reduced-motion`",
      "",
      "## 结论",
      "3 项审查全部通过，可以进入交付。",
    ].join("\n"),
    delivery: [
      "# 交付总结",
      "",
      "## 本次交付",
      "任务管理应用支持暗色模式：右上角开关切换，默认跟随系统，记住用户选择。",
      "",
      "## 变更文件",
      "- `target-app/index.html`",
      "- `target-app/styles.css`",
      "- `target-app/app.js`",
      "- `tests/theme.test.js`（新增）",
      "",
      "## 验证",
      "- 6 个测试用例全部通过",
      "- 3 个审查 Agent 全部通过（自动回归 1 次）",
      "",
      "## 后续建议",
      "- 设置页增加同样的主题选项",
      "- 收集暗色模式使用率，再决定是否做多套主题",
    ].join("\n"),
  };

  window.__DEVFLOW_DEMO_CONTENT = CONTENT;

  var EXTRA = {
    requirement: { prototypeHtml: PROTOTYPE },
    design: {
      visualPlan: {
        title: "实现蓝图",
        summary: "颜色变量化 → 首帧定主题 → 开关与持久化",
        nodes: [
          { label: "抽取颜色变量", detail: "styles.css 里 10 处颜色改为 :root 变量" },
          { label: "暗色变量覆盖", detail: ":root[data-theme=dark] 一套暗色值" },
          { label: "首帧定主题", detail: "head 内联脚本：已保存 > 系统设置" },
          { label: "开关与持久化", detail: "role=switch，选择写入 localStorage" },
        ],
        risks: ["首帧闪白", "暗色对比度", "隐私模式写入失败"],
      },
    },
    code: { changedFiles: ["target-app/index.html", "target-app/styles.css", "target-app/app.js"], workspacePath: "runs/demo" },
    test: { changedFiles: ["tests/theme.test.js"], workspacePath: "runs/demo" },
    review: {},
    delivery: {},
  };

  var STATS = {
    requirement: [8200, 1460, 1180],
    design: [6400, 2210, 860],
    code: [11800, 3020, 2140],
    test: [7300, 3380, 1260],
    review: [9600, 4150, 920],
    delivery: [4100, 2600, 540],
  };

  /* ---------------- 状态机 ---------------- */

  var pipeline = null;
  var now = function () { return new Date().toISOString(); };

  function stageIndex(id) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return i;
    return 0;
  }

  function newPipeline(requirement, template) {
    pipeline = {
      id: "demo", requirement: requirement, template: template || "feature", projectPath: null,
      status: "ready", currentStageId: "requirement", stages: STAGES, artifacts: {}, reviewHistory: [],
      createdAt: now(), startedAt: now(), completedAt: "",
    };
    return pipeline;
  }

  function makeArtifact(stage, attempt, rejectReason) {
    var s = STATS[stage.id];
    var content = CONTENT[stage.id];
    if (rejectReason) content = "> 已根据评审意见修改：" + rejectReason + "\n\n" + content;
    var art = {
      stageId: stage.id, stageName: stage.name, agent: stage.agent, skill: stage.skill,
      content: content, createdAt: now(), model: MODEL, changedFiles: [], workspacePath: null,
      startedAt: now(), completedAt: now(), latencyMs: s[0], promptTokens: s[1], completionTokens: s[2],
      totalTokens: s[1] + s[2], reasoningContent: "", attempt: attempt,
    };
    var extra = EXTRA[stage.id] || {};
    Object.keys(extra).forEach(function (k) { art[k] = extra[k]; });
    return art;
  }

  function workspaceFiles() {
    if (!pipeline) return [];
    var files = [];
    var order = ["requirement", "design", "code", "test", "review", "delivery"];
    order.forEach(function (id, i) {
      var a = pipeline.artifacts[id];
      if (!a) return;
      files.push({ name: "0" + (i + 1) + "-" + id + ".md", size: new Blob([a.content]).size });
    });
    if (pipeline.artifacts.code) {
      files.push({ name: "target-app/index.html", size: 1180 }, { name: "target-app/styles.css", size: 2210 }, { name: "target-app/app.js", size: 1020 });
    }
    if (pipeline.artifacts.test) files.push({ name: "tests/theme.test.js", size: 2380 });
    return files;
  }

  /* ---------------- fetch 拦截 ---------------- */

  var realFetch = window.fetch.bind(window);
  function json(data, status) {
    return Promise.resolve(new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json" } }));
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    var u = new URL(url, location.href);
    if (u.pathname.indexOf(BASE + "/") !== 0) return realFetch(input, init);
    var path = u.pathname.slice(BASE.length);
    var method = (init && init.method) || "GET";
    var body = init && init.body ? JSON.parse(init.body) : {};

    if (path === "/health") return json({ status: "ok", demo: true });
    if (path === "/pipelines" && method === "POST") {
      return wait(400).then(function () { return json(newPipeline(body.requirement, body.template)); });
    }
    var m = path.match(/^\/pipelines\/demo(\/.*)?$/);
    if (m) {
      var sub = m[1] || "";
      if (!pipeline) return json({ detail: "Pipeline 不存在，请重新开始" }, 404);
      if (sub === "" && method === "GET") return json(pipeline);
      if (sub === "/review" && method === "POST") {
        var r = review(body.decision, body.reason);
        return r.__error ? json({ detail: r.__error }, 400) : json(r);
      }
      if (sub === "/workspace") {
        return json({ files: workspaceFiles(), path: "runs/demo", git: pipeline.artifacts.code ? { branch: "devflow/dark-mode", commit: "3f9a2c1", log: "feat: 任务管理应用支持暗色模式" } : null });
      }
      var f = sub.match(/^\/workspace\/files\/(\d\d)-(\w+)\.md$/);
      if (f && pipeline.artifacts[f[2]]) {
        return Promise.resolve(new Response(pipeline.artifacts[f[2]].content, { headers: { "Content-Type": "text/markdown; charset=utf-8" } }));
      }
      if (sub.indexOf("/code-search") === 0) return json({ results: codeSearch(u.searchParams.get("q") || "") });
    }
    // 其余（真实代码文件、产品预览）走静态文件
    return realFetch(input, init);
  };

  function review(decision, reason) {
    var stage = STAGES[stageIndex(pipeline.currentStageId)];
    if (decision === "reject" && !String(reason || "").trim()) {
      return { __error: "打回需要填写原因" };
    }
    pipeline.reviewHistory.push({ stageId: stage.id, stageName: stage.name, decision: decision, reason: reason || "", createdAt: now() });
    if (decision === "approve") {
      var i = stageIndex(stage.id);
      if (i === STAGES.length - 1) {
        pipeline.status = "completed";
        pipeline.completedAt = now();
      } else {
        pipeline.status = "ready";
        pipeline.currentStageId = STAGES[i + 1].id;
      }
    } else {
      // 打回：清掉本阶段产物，带着原因重新生成
      delete pipeline.artifacts[stage.id];
      pipeline.status = "ready";
      pipeline._rejectReason = reason;
    }
    return pipeline;
  }

  var SYMBOLS = [
    { name: "toggleTheme", kind: "function", file: "target-app/app.js", line: 27, snippet: "function toggleTheme() {" },
    { name: "applyTheme", kind: "function", file: "target-app/app.js", line: 22, snippet: "function applyTheme(theme) {" },
    { name: "renderTasks", kind: "function", file: "target-app/app.js", line: 11, snippet: "function renderTasks() {" },
    { name: "#themeToggle", kind: "html_element", file: "target-app/index.html", line: 22, snippet: '<button id="themeToggle" class="theme-toggle" role="switch">' },
    { name: ":root[data-theme=\"dark\"]", kind: "css_rule", file: "target-app/styles.css", line: 13, snippet: ':root[data-theme="dark"] {' },
    { name: ".theme-toggle", kind: "css_rule", file: "target-app/styles.css", line: 55, snippet: ".theme-toggle {" },
    { name: "click", kind: "event", file: "target-app/app.js", line: 37, snippet: 'themeToggle.addEventListener("click", toggleTheme);' },
  ];
  function codeSearch(q) {
    q = q.toLowerCase();
    return SYMBOLS.filter(function (s) { return s.name.toLowerCase().indexOf(q) !== -1 || s.snippet.toLowerCase().indexOf(q) !== -1; });
  }

  /* ---------------- EventSource 模拟 ---------------- */

  var RealEventSource = window.EventSource;

  function chunksOf(text) {
    var out = [];
    var i = 0;
    while (i < text.length) {
      var n = 6 + Math.floor(Math.random() * 14);
      out.push(text.slice(i, i + n));
      i += n;
    }
    return out;
  }

  function DemoEventSource(url) {
    var self = this;
    this.url = url;
    this.readyState = 0;
    this._listeners = {};
    this._timers = [];
    this.onerror = null;
    setTimeout(function () { self.readyState = 1; self._run(); }, 200);
  }
  DemoEventSource.CONNECTING = 0;
  DemoEventSource.OPEN = 1;
  DemoEventSource.CLOSED = 2;
  DemoEventSource.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  };
  DemoEventSource.prototype.close = function () {
    this.readyState = 2;
    this._timers.forEach(clearTimeout);
  };
  DemoEventSource.prototype._emit = function (type, data) {
    if (this.readyState === 2) return;
    (this._listeners[type] || []).forEach(function (fn) { fn({ type: type, data: data }); });
  };
  DemoEventSource.prototype._run = function () {
    var self = this;
    if (!pipeline || pipeline.status !== "ready") {
      self._emit("done", "");
      return;
    }
    var stage = STAGES[stageIndex(pipeline.currentStageId)];
    var reason = pipeline._rejectReason;
    pipeline._rejectReason = null;
    var prev = pipeline.reviewHistory.filter(function (r) { return r.stageId === stage.id && r.decision === "reject"; }).length;
    var art = makeArtifact(stage, prev + 1, reason);
    var steps = [];
    var t = 0;
    function at(delay, fn) { t += delay; steps.push([t, fn]); }

    at(0, function () { self._emit("stage", stage.name); });
    at(150, function () { self._emit("system", "加载技能文件 " + stage.skill.path); });
    if (reason) at(300, function () { self._emit("system", "收到打回意见：" + reason + "，重新生成"); });
    at(400, function () { self._emit("system", stage.agent + " 开始工作"); });

    if (stage.id === "review") {
      ["正确性", "安全性", "规范性"].forEach(function (k, i) {
        at(250 + i * 120, function () { self._emit("system", "启动 " + k + "审查 Agent（并行）"); });
      });
      at(900, function () { self._emit("chunk", "[正确性审查] 发现问题：开关初始 aria-checked 未与当前主题同步。\n"); });
      at(400, function () {
        self._emit("auto_regression", JSON.stringify({ stageName: "代码生成", retry: 1, maxRetries: 3, reason: "开关初始 aria-checked 未同步" }));
      });
      at(700, function () { self._emit("chunk", "[代码生成 Agent] 已在 applyTheme 中同步 aria-checked，重新提交审查。\n\n"); });
      at(300, function () { self._emit("system", "第 2 轮审查开始"); });
    }

    chunksOf(art.content).forEach(function (c) { at(18 + Math.random() * 22, function () { self._emit("chunk", c); }); });

    at(200, function () {
      pipeline.artifacts[stage.id] = art;
      pipeline.status = "waiting_review";
      if (stage.id === "code") self._emit("system", "已写入运行工作区 runs/demo，产品预览可用");
      self._emit("stats", JSON.stringify({
        stageId: stage.id, stageName: stage.name, agent: stage.agent, model: MODEL, status: "completed",
        startedAt: art.startedAt, completedAt: art.completedAt, latencyMs: art.latencyMs,
        promptTokens: art.promptTokens, completionTokens: art.completionTokens, totalTokens: art.totalTokens, attempt: art.attempt,
      }));
    });
    at(150, function () { self._emit("done", ""); self.close(); });

    steps.forEach(function (s) { self._timers.push(setTimeout(s[1], s[0])); });
  };

  window.EventSource = function (url, opts) {
    var u = new URL(url, location.href);
    if (u.pathname.indexOf(BASE + "/") === 0) return new DemoEventSource(url);
    return new RealEventSource(url, opts);
  };
  window.EventSource.CLOSED = 2;
  window.EventSource.OPEN = 1;
  window.EventSource.CONNECTING = 0;

  /* ---------------- 页面上的演示说明 ---------------- */

  document.addEventListener("DOMContentLoaded", function () {
    document.documentElement.classList.add("is-demo");
    // 示例需求已经写清楚，演示里跳过澄清问答
    if (window.DevFlowClarificationFlow) {
      window.DevFlowClarificationFlow.shouldAskClarification = function () { return false; };
    }
    var input = document.querySelector("#requirementInput");
    if (input) {
      input.value = DEMO_REQUIREMENT;
      input.readOnly = true;
      input.dispatchEvent(new Event("input"));
    }
    var select = document.querySelector("#templateSelector");
    if (select) { select.value = "feature"; select.disabled = true; }
    var card = document.querySelector("#runner");
    if (card) {
      var note = document.createElement("div");
      note.className = "demo-note";
      note.innerHTML = '<span class="demo-note__tag">在线演示</span><span>回放一次预先生成的示例运行：需求固定，每个阶段照样会停下来等你通过或打回。代码阶段产出的页面和测试文件都能真正运行。</span>';
      card.appendChild(note);
    }
    // ?autoplay=N：自动跑到第 N 个阶段的确认点（用于截图）
    var autoplay = parseInt(params.get("autoplay") || "0", 10);
    if (autoplay > 0) {
      setTimeout(function () {
        var stops = 0;
        document.querySelector(".run-button").click();
        var timer = setInterval(function () {
          var status = document.querySelector("#pipelineStatus").textContent;
          if (status !== "等待你确认") return;
          stops += 1;
          if (stops >= autoplay) { clearInterval(timer); return; }
          document.querySelector("#approveButton").click();
        }, 300);
      }, 300);
    }
  });
})();

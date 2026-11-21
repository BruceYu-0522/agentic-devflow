(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.DevFlowClarificationFlow = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 只有需求过短或含糊时才弹澄清。超过这个长度且包含明确动作的
  // 需求直接生成，不打扰用户。
  var MIN_CLEAR_LENGTH = 20;

  // 需求里出现这些动词之一，视为“知道要做什么”。没有动词的需求
  // （例如只写了名词堆砌）会被认为含糊。
  var ACTION_VERBS = [
    "做", "加", "改", "实现", "支持", "显示", "生成", "排序", "搜索",
    "登录", "注册", "保存", "删除", "编辑", "上传", "下载", "计算",
    "统计", "提醒", "推送", "跳转", "切换", "创建", "更新", "增加",
    "减少", "优化", "修复", "重构", "开发", "搭建", "设计", "编写",
    "接入", "集成", "提供", "允许", "能够", "需要", "想要", "希望",
    "管理", "查看", "展示", "导出", "导入", "同步", "验证", "校验",
    "过滤", "筛选", "推荐", "收藏", "分享", "评论", "点赞", "退出",
    "刷新", "加载", "渲染", "绘制", "播放", "暂停", "调整", "设置",
    "配置", "安装", "部署", "监控", "分析", "预测", "识别", "翻译",
    "转换", "合并", "拆分", "复制", "粘贴", "移动", "拖拽", "点击",
    "选择", "输入", "输出", "发送", "接收", "通知", "记录", "跟踪",
    "比较", "分组", "汇总", "修复",
    "add", "create", "fix", "support", "show", "sort", "search",
    "login", "save", "delete", "update", "export", "import", "build",
  ];

  var LABELS = {
    targetUser: "目标用户",
    acceptanceFocus: "验收重点",
  };

  function hasActionVerb(requirement) {
    var text = String(requirement || "");
    for (var i = 0; i < ACTION_VERBS.length; i++) {
      if (text.indexOf(ACTION_VERBS[i]) !== -1) return true;
    }
    return false;
  }

  function shouldAskClarification(requirement) {
    var text = String(requirement || "").trim();
    if (text.indexOf("需求澄清回答：") !== -1) return false;
    if (text.length < MIN_CLEAR_LENGTH) return true;
    if (!hasActionVerb(text)) return true;
    return false;
  }

  function shortRequirement(requirement) {
    var text = String(requirement || "").trim();
    return text.length > 24 ? text.slice(0, 24) + "…" : text;
  }

  /**
   * 只问 2 道题，问题本身由用户需求动态生成（把原始需求嵌进题干），
   * 而不是 4 道与需求无关的固定题。recommended 留空：没有放之四海
   * 皆准的推荐答案，答多少算多少，不答也直接生成。
   */
  function getClarificationQuestions(requirement) {
    var short = shortRequirement(requirement);
    return [
      {
        id: "targetUser",
        label: "给谁用",
        question: "「" + short + "」主要给谁用？在什么场景下用？",
        recommended: "",
        placeholder: "例如：经常在晚上整理任务的个人用户",
      },
      {
        id: "acceptanceFocus",
        label: "怎么算做好",
        question: "做完之后，你怎么判断「" + short + "」算做好了？最关键的一两个表现是什么？",
        recommended: "",
        placeholder: "例如：点开关立刻切换，刷新后还保持",
      },
    ];
  }

  function mergeClarificationAnswers(requirement, answers) {
    var lines = [
      "原始需求：",
      String(requirement || "").trim(),
      "",
      "需求澄清回答：",
    ];

    var answered = 0;
    Object.keys(LABELS).forEach(function (key) {
      var value = String((answers && answers[key]) || "").trim();
      if (value) {
        answered += 1;
        lines.push("- " + LABELS[key] + "：" + value);
      }
    });

    // 一道都没答：不要往 PRD 里掺水，直接返回原始需求。
    if (answered === 0) return String(requirement || "").trim();

    lines.push("");
    lines.push("请需求分析 Agent 优先基于以上用户回答生成正式 PRD；如果仍有关键不确定项，再进入下一轮澄清。");
    return lines.join("\n");
  }

  return {
    MIN_CLEAR_LENGTH: MIN_CLEAR_LENGTH,
    getClarificationQuestions: getClarificationQuestions,
    mergeClarificationAnswers: mergeClarificationAnswers,
    shouldAskClarification: shouldAskClarification,
  };
});

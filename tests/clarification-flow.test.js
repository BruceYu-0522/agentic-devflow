const assert = require("node:assert/strict");
const {
  getClarificationQuestions,
  mergeClarificationAnswers,
  shouldAskClarification,
} = require("../clarification-flow");

// 只问 2 道题，且问题由需求本身动态生成（题干里嵌着原始需求）。
const requirement = "做一个冒泡排序可视化网页";
const questions = getClarificationQuestions(requirement);
assert.equal(questions.length, 2, "should ask only 2 questions");
assert.deepEqual(questions.map((q) => q.id), ["targetUser", "acceptanceFocus"]);
assert.ok(questions.every((question) => question.id));
assert.ok(questions.every((question) => question.question.includes(requirement)),
  "questions should be generated from the requirement itself");
assert.ok(questions.every((question) => question.placeholder));

// 动态问题没有放之四海皆准的推荐答案
assert.ok(questions.every((question) => question.recommended === ""));

// ── shouldAskClarification：只在需求过短 / 含糊时出现 ──

// 短需求（少于 20 字）→ 问
assert.equal(shouldAskClarification("做一个冒泡排序可视化网页"), true);
assert.equal(shouldAskClarification("页面"), true);
assert.equal(shouldAskClarification(""), true);

// 够长、含糊（没有动词，只是一堆名词）→ 问
assert.equal(shouldAskClarification("一个非常好看的页面和整体视觉效果以及配色方案"), true);

// 够长、有明确动作 → 不问，直接生成
assert.equal(
  shouldAskClarification("给任务列表加一个按截止日期排序的功能，支持升序和降序切换"),
  false
);
assert.equal(
  shouldAskClarification("给任务管理应用增加暗色模式：右上角有开关，默认跟随系统，记住用户的选择。"),
  false
);

// 已经回答过澄清的 → 不问
assert.equal(shouldAskClarification("原始需求：做页面\n\n需求澄清回答：\n- 目标用户：学生"), false);

// ── mergeClarificationAnswers：只合并用户真正答了的内容 ──

const merged = mergeClarificationAnswers("做一个冒泡排序可视化网页", {
  targetUser: "学生和算法初学者",
  acceptanceFocus: "必须支持暂停、单步、速度调节",
});

assert.match(merged, /原始需求：\n做一个冒泡排序可视化网页/);
assert.match(merged, /需求澄清回答：/);
assert.match(merged, /目标用户：学生和算法初学者/);
assert.match(merged, /验收重点：必须支持暂停、单步、速度调节/);

// 只答一道：只合并答了的那一道
const partial = mergeClarificationAnswers("做一个冒泡排序可视化网页", {
  targetUser: "学生",
});
assert.match(partial, /目标用户：学生/);
assert.doesNotMatch(partial, /验收重点/);

// 一道没答：不掺水，直接返回原始需求
assert.equal(
  mergeClarificationAnswers("做一个冒泡排序可视化网页", {}),
  "做一个冒泡排序可视化网页"
);

console.log("clarification-flow tests passed");

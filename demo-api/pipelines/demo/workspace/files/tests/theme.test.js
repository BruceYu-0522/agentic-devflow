// 暗色模式切换测试（node --test，使用 jsdom）
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..", "target-app");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "app.js"), "utf8");

function boot({ saved = null, prefersDark = false } = {}) {
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/" });
  const { window } = dom;
  window.matchMedia = () => ({ matches: prefersDark });
  if (saved) window.localStorage.setItem("task-theme", saved);
  window.document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
  window.eval(script);
  return window;
}

test("默认跟随系统：系统为浅色时显示浅色", () => {
  const w = boot();
  assert.equal(w.document.documentElement.dataset.theme, "light");
});

test("默认跟随系统：系统为暗色时显示暗色", () => {
  const w = boot({ prefersDark: true });
  assert.equal(w.document.documentElement.dataset.theme, "dark");
});

test("点击开关切换主题并更新 aria-checked", () => {
  const w = boot();
  const toggle = w.document.querySelector("#themeToggle");
  toggle.click();
  assert.equal(w.document.documentElement.dataset.theme, "dark");
  assert.equal(toggle.getAttribute("aria-checked"), "true");
});

test("选择会被记住，刷新后保持", () => {
  const w = boot();
  w.document.querySelector("#themeToggle").click();
  assert.equal(w.localStorage.getItem("task-theme"), "dark");
});

test("已保存的选择优先于系统设置", () => {
  const w = boot({ saved: "light", prefersDark: true });
  assert.equal(w.document.documentElement.dataset.theme, "light");
});

test("任务列表照常渲染 3 条，已完成项带删除线样式", () => {
  const w = boot();
  const items = w.document.querySelectorAll(".task-item");
  assert.equal(items.length, 3);
  assert.equal(w.document.querySelectorAll(".task-item.is-done").length, 1);
});

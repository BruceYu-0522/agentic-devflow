const tasks = [
  { id: 1, title: "整理需求文档", done: false },
  { id: 2, title: "补充接口说明", done: false },
  { id: 3, title: "同步测试结果", done: true },
];

const THEME_KEY = "task-theme";
const taskList = document.querySelector("#taskList");
const themeToggle = document.querySelector("#themeToggle");

function renderTasks() {
  taskList.innerHTML = "";

  tasks.forEach((task) => {
    const item = document.createElement("li");
    item.className = task.done ? "task-item is-done" : "task-item";
    item.textContent = task.title;
    taskList.appendChild(item);
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute("aria-checked", String(theme === "dark"));
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_error) {
    // 隐私模式下写不进去也不影响切换
  }
}

themeToggle.addEventListener("click", toggleTheme);
applyTheme(document.documentElement.dataset.theme || "light");
renderTasks();

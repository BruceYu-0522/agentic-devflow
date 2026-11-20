# 代码变更

已修改 3 个文件，改动保存在运行工作区，可在下方查看代码和产品预览。

- `target-app/index.html`：标题区改为左右布局，右侧新增 `#themeToggle` 开关；`<head>` 新增首帧主题脚本
- `target-app/styles.css`：10 个颜色变量，`[data-theme="dark"]` 覆盖暗色；开关滑块动画；尊重“减弱动态效果”
- `target-app/app.js`：`applyTheme`、`toggleTheme`，选择写入 `localStorage`

```js
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (_error) {}
}
```

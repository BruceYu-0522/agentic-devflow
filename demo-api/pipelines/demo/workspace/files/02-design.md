# 技术方案：CSS 变量 + data-theme

## 现状
`target-app` 是一个静态页面：`index.html`、`styles.css`、`app.js`，颜色直接写死在样式里。

## 方案
1. 把所有颜色抽成 `:root` 上的 CSS 变量，新增 `:root[data-theme="dark"]` 覆盖一套暗色值
2. 在 `<head>` 里用一小段内联脚本，在首帧渲染前决定主题（已保存的选择 > 系统设置），避免闪白
3. `app.js` 新增 `applyTheme` / `toggleTheme`，开关用 `role="switch"` 和 `aria-checked` 表达状态
4. 选择写入 `localStorage`，写入失败（隐私模式）时不影响切换

## 改动文件
| 文件 | 改动 |
| --- | --- |
| `target-app/index.html` | 新增开关按钮和首帧主题脚本 |
| `target-app/styles.css` | 颜色改为变量，新增暗色变量和开关样式 |
| `target-app/app.js` | 新增主题切换与持久化逻辑 |

## 风险
- 首帧闪白：用内联脚本在样式加载前设置 `data-theme`
- 对比度不足：暗色文字与背景对比度不低于 4.5:1

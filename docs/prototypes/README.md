# Task Board 界面原型

12 套风格不同的高保真静态原型（A~C 第一辑、D~F 第二辑、G~I 第三辑、J~L 第四辑），均为**单文件、零依赖** HTML，浏览器直接打开即可预览（无需构建、无需启动服务）。数据为演示用 mock。第四辑按 `anthropics/skills@frontend-design`（主题化设计计划 + 签名元素）设计、按 `vercel-labs/agent-skills@web-design-guidelines`（Web Interface Guidelines）逐条审查（focus-visible / reduced-motion / tabular-nums / touch-action / overscroll-behavior / safe-area 等），前三辑未做该合规审查。

| 原型 | 文件 | 风格定位 |
| --- | --- | --- |
| A · 极简白 | [proto-a-minimal.html](proto-a-minimal.html) | 大留白、浅灰泳道、细边框、黑白主按钮；最克制，贴近 Linear/Notion 气质，信息密度高、视觉噪音最低 |
| B · 深色专业 | [proto-b-dark.html](proto-b-dark.html) | 深色底 + 靛蓝/青色辉光强调、等宽字体点缀、毛玻璃顶栏；贴近开发者工具（VS Code/GitHub Dark）气质，适合长时间盯板 |
| C · 多彩轻快 | [proto-c-playful.html](proto-c-playful.html) | 暖米色底、每列泳道一个马卡龙色、胶囊按钮与厚圆角；最活泼，状态一目了然，贴近个人效率工具（Trello/Things）气质 |
| D · 玻璃拟态 | [proto-d-glass.html](proto-d-glass.html) | 紫蓝粉高饱和渐变背景 + 半透明磨砂面板（backdrop-filter）、发光徽标；macOS/iOS 控制中心气质，最有「精致感」但性能开销最大 |
| E · 新拟态 | [proto-e-neumorph.html](proto-e-neumorph.html) | 全局统一灰蓝底色，零硬边框，全靠外凸/内凹双阴影浮雕分层；柔和安静、一体成型，但对比度低、可访问性最弱 |
| F · 新粗野主义 | [proto-f-brutal.html](proto-f-brutal.html) | 纸白底 + 3px 黑硬边 + 硬偏移阴影 + 高饱和平涂色块 + 超粗大写标题；海报/印刷感，最张扬，个性最强 |
| G · 终端极客 | [proto-g-terminal.html](proto-g-terminal.html) | 黑底终端绿字、全站等宽字体、`[ 待规划 ] (2)` / `> 任务` 等 ASCII 装饰、按钮 hover 反色、闪烁光标徽标；像 SSH 进服务器看 htop，零圆角零阴影 |
| H · 杂志编辑 | [proto-h-editorial.html](proto-h-editorial.html) | 纸白底 + 衬线大标题（Georgia/宋体）+ 发丝细分隔线 + 泳道编号 01~07 + 单一正红强调；瑞士排版/报纸内页气质，克制但有编辑感 |
| I · 粘土拟态 | [proto-i-clay.html](proto-i-clay.html) | pastel 渐变底 + 大圆角「粘土块」（外侧双向柔影 + inset 内亮外暗 3D 手感）、胖胶囊按钮按压凹陷；圆润可爱，与 C 的区别在立体质感 |
| J · 工程蓝图 | [proto-j-blueprint.html](proto-j-blueprint.html) | 深蓝 CAD 图纸：网格底、白线框泳道/卡片、四角十字定位标、进行中卡剖面线、尺寸标注式标签；「看板 = 软件施工图」，无实体色块 |
| K · 档案索引卡 | [proto-k-catalog.html](proto-k-catalog.html) | 木柜卡片盒：索引卡 + 顶部分类色条 + 横线卡纸，已完成卡盖朱砂「已验收」圆形印章（签名元素）；「验收 = 盖章归档」 |
| L · 软木便利贴 | [proto-l-cork.html](proto-l-cork.html) | 软木板 + 手写体便签：红图钉、±1.5° 随手钉上微旋转、胶带泳道条、红旗「异常退出」、折角「[提问]」；看板的物理本源 |

## 每套原型覆盖的界面元素

- 桌面端：五列状态泳道（待规划/待办/进行中/待验收/已完成）+ 阻塞、已取消两个分支列
- 任务卡片：标题、优先级（高/普通/低）、项目标签、任务号、执行中 Agent 徽标（含用时）、红色「异常退出」卡片、「[提问] 等待答复」、「已验收」标记
- 任务详情抽屉：左栏属性/描述/验收标准/流转按钮，右栏评论流 + 大输入框 + 「发表评论 / 执行 / 问答 / 停止」按钮行
- 移动端（视口 ≤768px，缩窄浏览器窗口即可看到）：泳道变为纵向手风琴（点击列头展开/收起），卡片内操作为按钮，不依赖拖拽/悬停/横向滑动

## 打开方式

```bash
open docs/prototypes/proto-a-minimal.html   # a ~ l 共 12 套
```

任意原型 URL 后加 `#drawer` 可直接打开任务详情抽屉视图（如 `proto-d-glass.html#drawer`）。

或用任意静态服务器（非必需）：`npx serve docs/prototypes`（注意：项目本身零 npm 依赖，这只是预览方式之一）。

## 说明

- 原型中的少量内联 JS 仅用于演示手风琴折叠与抽屉开关，非实现建议。
- 与现行前端（`public/`）的对应关系：卡片字段、`[提问]` 高亮、异常退出红卡、抽屉双栏布局均按现有数据模型绘制，任何一套选定后都可直接映射到 `public/style.css` 的改造。

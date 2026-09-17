# 火山引擎额度监测器（Volc Quota Monitor）

一个小巧的 Windows 桌面常驻挂件，实时显示**火山方舟（Volcengine Ark）**订阅套餐的额度占用情况，
同时覆盖 **Agent Plan** 与 **Coding Plan** 两条线（各三条周期：`5 小时` / `周用量` / `月用量`）。
数据来自火山引擎官方命令行工具 **Ark CLI**。

## 核心特性

- **剩余口径（倒计时式）**：进度条长度与百分比都是「**还剩多少**」，数字随消耗往下掉。
  看「还剩几成」比看「用了几成」更直观，也避免了「条越满越危险」的反直觉。
- **40×40 小图标**：收起态只是一个不挡事的小圆环（弧长 = 剩余量），鼠标悬停才展开面板。
  **图标可以贴住屏幕的任意边缘**（但不越界），展开的面板会自动朝屏幕内侧打开 ——
  两者分别按屏幕边界单独计算、互不干扰。
- **双计划分组面板**：Agent Plan / Coding Plan 上下两块，各三条进度条；
  **没订阅的计划占一行显示「未订阅 Agent Plan」**，不会整块消失让人以为软件坏了。
  订阅与否**不看 CLI 的 `subscribed` 字段**（实测不可靠，见「十、解析层踩过的坑」），
  而是看这个计划有没有真实用量数据。
- **系统托盘常驻**：右键即可看到两条计划的进度条（`████░░░░ 52.0%`）+ 重置时刻，
  还能切换圆环盯的订阅、显示/隐藏挂件、立即刷新。
- **单击图标切换订阅**：点一下桌面小图标（或托盘图标），圆环在已订阅的计划之间轮换，
  并在屏幕上弹一条渐入提示「已切换到 Coding Plan · 5 小时」，随后自动淡出。
- **零第三方运行时依赖**：渲染层为原生 DOM + Canvas 2D，`dependencies` 为空对象。

---

## 一、前置依赖（必须由用户手动完成）

软件依赖本机的 arkcli 登录态，SSO 是浏览器交互式登录，**无法由软件代劳**：

```bash
# 1. 全局安装官方 Ark CLI
npm i -g @volcengine/ark-cli

# 2. 浏览器 SSO 登录（登录态约保留 47 小时）
arkcli auth login volc-sso

# 3. 确认登录态
arkcli auth status

# 4. （可选）手动跑一次确认有输出
arkcli usage plan --all --format json
```

> ⚠️ **必须带 `--all`**。不带 `--all` 时 CLI 只会返回「探测到的」套餐桶，
> 实测会把已订阅的 Agent Plan 整个漏掉（面板上就永远看不到 Agent Plan）。
> 软件内部调用时已经带上了这个参数。

---

## 二、启动

```bash
# 安装开发依赖（仅 electron / electron-builder）
npm install

# 正常启动（走真实 arkcli）
npm start
```

### 国内网络加速（可选，但强烈建议）

本机 npm 直连官方源可能极慢（单个包可能要 90 秒以上，`electron` 二进制尤其慢），
首次 `npm install` 建议走国内镜像：

```bash
npm install --registry=https://registry.npmmirror.com
```

`electron` 的**二进制**不走 npm registry，需要额外指定镜像（PowerShell 示例）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install --registry=https://registry.npmmirror.com
```

> 想永久生效可写进 npm 配置：`npm config set registry https://registry.npmmirror.com`
> 以及用户级环境变量 `ELECTRON_MIRROR`。

启动后立即查询一次，此后每 **30 秒**轮询一次（间隔可配置，见「五、配置项」）。

---

## 三、交互方式

| 操作 | 效果 |
| --- | --- |
| 鼠标移到小图标上 | 约 260ms 后展开双计划面板 |
| 鼠标移开 | 约 220ms 后收回为小图标 |
| **单击小图标** | 在已订阅的计划之间切换圆环盯的订阅，并弹一条渐入提示 |
| **按住小图标拖动** | 移动图标。图标可以贴住屏幕任意边缘，但不会越界；拖完自动记住 |
| **按住展开面板拖动** | 移动整个面板。面板始终完整留在屏幕内，拖到边缘就停住 |
| **托盘图标左键单击** | 等同于「单击小图标」 |
| **托盘图标右键** | 弹出菜单：查看进度条 / 切换圆环订阅 / 显示隐藏挂件 / 立即刷新 / 退出 |

说明：

- **图标与面板的边界是各自独立算的**。窗口尺寸固定等于面板尺寸（360×316），而图标可以在
  窗口内移位 —— 所以「图标贴住屏幕右下角」和「面板不伸出屏幕」能同时成立：靠近右边时
  面板向左开、靠近下边时向上开，图标则始终完整落在屏幕工作区内。
  这段解算是纯函数（`src/layout.js`），由 `tests/layout.test.js` 穷举扫描钉住两条不变式：
  `窗口位置 + 图标偏移 == 图标屏幕位置`、`图标与面板都完整落在工作区内`。
- **为什么拖拽要自己实现**：`-webkit-app-region: drag` 会把这个区域的鼠标事件全部吞掉
  （连 CSS `:hover` 都失效），那样「单击图标切换订阅」永远收不到 `click`；而且系统拖动
  完全不受我们控制，没法按屏幕边界钳制。现在改成渲染层判定位移与时长（< 4px 算单击，
  否则算拖拽），主进程用已有的 40Hz 光标轮询跟着光标移动窗口 —— 三种手势
  （悬停 / 单击 / 拖拽）在同一块 40px 区域里干净共存，钳制规则也完全在自己手里。
- **为什么悬停展开要延迟 260ms**：图标只有 40px，如果「一靠近就展开」，面板会在
  `mousedown` 之前就把图标顶掉，点击这个手势就永远做不出来。260ms 是给点击留的窗口期，
  体感上几乎察觉不到。
- **未展开时鼠标可穿透**到桌面其它窗口；悬停与命中判定由主进程按系统光标位置计算，
  不依赖页面鼠标事件，所以不会出现「划过没反应」。
- 位置保存在 `%APPDATA%\volc-quota-monitor\config.json` 的 `iconPos` 字段（图标屏幕位置）。
  显示器被拔掉 / 改分辨率后会重新钳制一次，不会跑到看不见的地方。

## 四、系统托盘

右键托盘图标可看到：

```
火山方舟额度 · 更新 16:32:10
────────────────────────────
Agent Plan · 个人版
    5 小时   ████████   100.0%
              暂无重置时间
    周用量   ████████   100.0%
              暂无重置时间
    月用量   ████████   100.0%
              暂无重置时间
────────────────────────────
Coding Plan · 个人版
    5 小时   ████░░░░    52.0%
              09-17 18:55 重置
    周用量   ███░░░░░    44.3%
              09-21 00:00 重置
    月用量   ██████░░    72.1%
              10-15 23:59 重置
────────────────────────────
圆环显示：Coding Plan · 5 小时（点击切换）
────────────────────────────
☑ 显示桌面挂件
  立即刷新
────────────────────────────
  退出
```

- 进度条用 `█` / `░` 文本渲染（原生菜单不支持 HTML），并**直接放在标题里**
  —— `sublabel` 在部分 Windows 版本不渲染，只放那儿会出现「菜单里看不到进度」。
- **「显示桌面挂件」是唯一的设置项**。隐藏后托盘仍常驻，随时可以从这里放回来。
- 退出只走菜单里的「退出」；关掉挂件窗口不会退出进程（托盘常驻型应用的常规行为）。

## 五、配置项

配置在 `%APPDATA%\volc-quota-monitor\config.json`：

```json
{
  "intervalMs": 30000,
  "miniPlan": "coding-plan",
  "showWidget": true,
  "iconPos": { "x": 1520, "y": 60 }
}
```

| 字段 | 说明 |
| --- | --- |
| `intervalMs` | 轮询间隔（毫秒），最小值保护 5000 |
| `miniPlan` | 圆环盯的计划 product。**不写也能用** —— 首次启动会自动挑「5 小时剩余最少」的那条（也就是最紧张的那条），单击图标切换后写回这里 |
| `showWidget` | 桌面挂件是否可见（托盘菜单里的开关会写这里） |
| `iconPos` | 小图标的**屏幕位置**（不是窗口位置）。窗口位置是「图标位置 − 图标在窗偏移」推导出来的，而那个偏移会随展开方向变化，所以只有图标位置才是稳定锚点 |

配置文件不存在时首次启动会自动写入默认值。
老版本存的是 `winPos`（那时图标钉在窗口正中），首次启动会自动换算成 `iconPos`，不用手动迁移。

## 六、`--mock` 演示模式（不调用真实 CLI）

无需登录、无需联网即可查看界面与全部状态分支：

```bash
npm run mock                      # 等价于 --mock=normal
npx electron . --mock=normal      # 正常：Agent Plan + Coding Plan 双计划，含 RFC3339 重置时间
npx electron . --mock=low         # 告警档：剩余 4% / 8.5%，看 danger 红紫配色
npx electron . --mock=edge        # 边界：reset_at=-1 / 非法时间 / 秒与毫秒混用 / 未订阅项 / 团队版带席位
npx electron . --mock=empty       # 空数据：未订阅任何套餐
npx electron . --mock=noauth      # 未登录：auth_method='none'
npx electron . --mock=error       # 查询失败
npx electron . --mock=no_cli      # 未安装 arkcli
```

> 场景名**大小写与连字符均不敏感**：`no_cli` / `no-cli` / `nocli` / `NO_CLI` 均可；
> `low` / `alert` / `danger` 等价。输入了无法识别的场景名时，控制台会打印
> `[mock] 未知的 mock 场景「xxx」，已回落为「normal」` 并列出可用场景，不会静默忽略。

---

## 七、异常兜底

| 状态 | 表现 |
| --- | --- |
| `NO_CLI` 未安装 | 图标变暗灰，展开显示安装命令，**点击即可复制** |
| `NO_AUTH` 未登录 / SSO 过期 | 图标紫色呼吸闪烁，展开提示登录，**一键唤起 `arkcli auth login volc-sso`** |
| `ERROR` 查询失败 | 右上角红紫小点告警，**保留上一次有效数据继续显示** |
| `EMPTY` 无已订阅套餐 | 展开提示「未检测到已订阅套餐」+ 重新登录按钮 |
| 某条周期无 `reset_at` | 该行显示「暂无重置时间」（绝不落成 1969 年） |
| `LOADING` 首次查询中 | 进度条走位循环动画 |

**铁律：任何查询异常（`ERROR` / `NO_CLI` / `NO_AUTH`）都不会让窗口"闪空"或消失，始终保留上一次的有效数据。**
`EMPTY`（无已订阅套餐）是正常兜底态而非异常，单独全屏提示，不携带陈旧数据。

---

## 八、校验与测试

三层验证，全部零依赖、纯 node 驱动：

```bash
# 1) 纯函数单测 —— 不启动 GUI，秒级返回
npm test                      # = 解析层 30 项 + 图标/面板边界解算 16 项
node tests/parse.test.js      # 只跑解析层
node tests/layout.test.js     # 只跑边界解算（含两条不变式的穷举扫描）

# 2) 启动冒烟 —— 真实拉起 Electron，读渲染进程 DOM 做断言
npm run smoke                 # 默认 mock=normal
node tests/smoke.js empty     # 指定场景：normal / low / edge / empty / noauth / error / no_cli

# 3) 重新生成托盘图标（改了品牌色 / 图形时用）
npm run icons
```

冒烟脚本做的是：

1. 用独立 `--user-data-dir` 启动，**完全不碰你真实的 `config.json`**
2. 入口是 `tests/smoke-main.js`：它 `require` 真实的 `main.js`（窗口、托盘、轮询、IPC
   全部按生产逻辑跑），再用 `executeJavaScript` 读渲染进程的**真实 DOM**
3. 断言：双计划分组、6 条进度条、剩余口径、圆环盯的计划、未订阅占位文案
4. 触发一次「切换订阅」，断言 IPC → 主进程 → 回推 → 渲染的完整链路
5. 收尾：kill 进程 + 删掉临时 user-data-dir

> **沙箱 / 无显卡环境**：脚本会自动附加一组 Chromium 开关
> （`--disable-gpu --in-process-gpu --no-sandbox`）。在没有可用 GPU 的机器上，
> Electron 的 GPU 进程会反复启动失败并 `FATAL ... GPU process isn't usable` 直接退出，
> 这是**环境问题而非软件缺陷**（见「十二、故障排查」）。可用 `SMOKE_EXTRA_FLAGS` 追加参数。

### 解析层单测入口

`src/parse.js` 与 `src/mock.js` 均为零依赖纯模块，可在 node 下直接 require：

```js
const { normalizeSnapshot, parseTimeValue, formatResetTime, selectRingCandidates } = require('./src/parse');
const { getMockScenario } = require('./src/mock');

const snap = normalizeSnapshot(getMockScenario('normal').data);
console.log(snap.status, snap.plans.map((p) => `${p.product}:${p.state}`));
// OK [ 'agent-plan:ok', 'coding-plan:ok', 'agent-plan-team:no-seat', 'coding-plan-team:no-seat' ]
```

---

## 九、打包 portable 单文件

```bash
npm run dist
```

产物：`release/VolcQuotaMonitor-<version>-portable.exe`（免安装、绿色、可直接扔 U 盘）。

### 打包前先挂国内镜像

`electron-builder` 除了 npm 包，还要额外下载 **electron 的 111MB zip** 和它自己的工具包
（winCodeSign / nsis），不挂镜像基本必然超时：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

### 报错 `Cannot create symbolic link ... 客户端没有所需的特权`

完整形态：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权 :
  ...\electron-builder\Cache\winCodeSign\<随机名>\darwin\10.12\lib\libcrypto.dylib
（7za 退出码 2 → electron-builder 判定解压失败，重试 4 次后放弃，exit 1）
```

**这是 Windows 环境问题，不是项目问题**：`winCodeSign-2.6.0.7z` 里带着 macOS 的符号链接，
而 Windows 普通账户没有创建符号链接的特权（`SeCreateSymbolicLinkPrivilege`），
7-Zip 解压必然报错。

符号链接全部位于 `darwin/` 子目录，而 Windows 打包只需要 `windows-10/` 里的工具 ——
手动解压并排除它、让缓存就位即可（electron-builder 检查该目录存在就跳过下载解压）：

```powershell
$cache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\winCodeSign"
$7za = "node_modules\7zip-bin\win\x64\7za.exe"
& $7za x -bd -y "$cache\<任意一个>.7z" "-o$cache\winCodeSign-2.6.0" "-xr!darwin"
```

> 等价方案：以管理员身份运行一次打包，或开启 Windows「开发者模式」授予符号链接权限。

### 其他说明

- 当前 exe 用的是 Electron 默认图标（日志会提示 `default Electron icon is used`）。
  想换成品牌图标，把 `build.win.icon` 指向一个含 256×256 的 `.ico` 即可。
- 体积：Electron 运行时下限由 Chromium 决定，**portable 单文件约 68MB、解包后约 172MB**，
  这是「Electron 框架」的体积下限，无法通过代码进一步压缩。

---

## 十、文件结构

```
volc-quota-monitor/
├── package.json            # 仅 electron + electron-builder 两个 devDependencies；dependencies 为空
├── main.js                 # 主进程：窗口、托盘、轮询调度、子进程、自实现拖拽、IPC
├── preload.js              # contextBridge 最小 API（含拖拽与切换订阅通道）
├── README.md
├── src/
│   ├── index.html          # 两态结构（MINI 小图标 / HOVER 双计划面板 / 渐入提示）
│   ├── style.css           # 紫黑主题 + 两态过渡 + 计划分组 + 兜底浮层
│   ├── renderer.js         # 状态机 + 分组渲染 + Canvas 粒子进度条 + 手势判定
│   ├── parse.js            # 归一化 / 解析纯函数（主进程与渲染层共用同一份）
│   ├── layout.js           # 图标 / 面板的屏幕边界解算（纯函数，可单测）
│   └── mock.js             # 内置假数据场景（7 个，含 RFC3339 时间生成）
├── scripts/
│   └── make-tray-icons.js  # 用 node zlib 手写 PNG 编码器生成托盘图标（零图形依赖）
├── tests/
│   ├── parse.test.js       # 解析层单测（30 项）
│   ├── layout.test.js      # 图标/面板边界解算单测（16 项）
│   ├── smoke.js            # 启动冒烟驱动（spawn Electron + 断言）
│   └── smoke-main.js       # 冒烟专用 Electron 入口（require 真实 main.js 后读 DOM）
└── assets/
    ├── logo.svg            # 品牌标记：2×2 紫色方块拼合的方舟标记
    ├── tray-16.png         # 托盘图标 1x（生成物）
    └── tray-32.png         # 托盘图标 2x（生成物）
```

### 解析层踩过的坑（都已在单测里钉死）

| 坑 | 症状 | 处理 |
| --- | --- | --- |
| `reset_at` 是 **RFC3339 字符串**而非数字 | 明明有重置时间却一直显示「暂无重置时间」 | `parseTimeValue` 统一收口数字 / 数字字符串 / ISO 字符串三种形态 |
| `usage plan` 不带 `--all` 会漏桶 | 面板上永远看不到 Agent Plan | 固定用 `usage plan --all`，并按 4 个桶补齐占位 |
| `session` 与 `5h` 是同一维度的两种叫法 | Coding Plan 的 5 小时识别不出来 | `normalizePeriodLabel` 统一归一 |
| 无 `reset_at` 字段是「周期内无数据」的哨兵 | 会误渲染成 1969 年 | 归一为 `-1`，展示为「暂无重置时间」 |
| 团队版 `subscribed:true` + `no-seat` 错误 | 会被误读成「已订阅」 | 单独识别为 `no-seat` 状态 |
| **CLI 的 `subscribed` 字段不可靠** | 账号根本没订 Agent Plan，CLI 依旧返回 `subscribed:true` + 三条 0%、无 `reset_at`，界面渲染成三条满进度条，看着像「额度满满」 | 判据改为 `hasRealData`：`reset_at` / `percent` / `used` 任一有值才算真订阅，否则归为「未订阅」 |
| 图标钉在窗口正中，而窗口尺寸 = 面板尺寸 | 图标永远离屏幕边缘 160px、根本贴不了边，且窗口大半在屏幕外会被系统往回拉 | 保留「图标在窗口内可移位」这个自由度，两个约束分别求解（`src/layout.js`） |
| 主进程首轮推送与渲染层订阅并发 | 界面永远停在 LOADING | 主进程 `did-finish-load` 补发 + 渲染层启动重试 + `init` 的 rAF 不得覆盖已到状态 |
| **只发生一次的状态仅靠推送下发** | 图标在窗口内的偏移那条消息丢了 → 渲染层按默认「窗口正中」画图标、主进程按真实偏移做命中判定，**两边错位 120px，鼠标移到图标上也打不开面板**（且不报错、日志干净） | 推送 + `invoke` 主动拉取**双通道**；冒烟里断言「渲染层用的位置 == 主进程下发的偏移」 |

---

## 十一、配色

| 用途 | 色值 |
| --- | --- |
| 背景 | `#0A0A0F` |
| 主紫（剩余充裕 > 40%） | `#A855F7` |
| 亮紫（剩余 15–40%） | `#C084FC` |
| 浅紫（正文） | `#E9D5FF` |
| 次紫（标签） | `#A78BFA` |
| 深紫（轨道） | `#1C1230` |
| 警示色（剩余 ≤ 15%） | `#F472B6` |

**分级按「剩余」判定**：剩余越少越告警（与「占用率越高越危险」是镜像的）。
圆环与三条进度条各自独立分级。

---

## 十二、故障排查

### 启动即崩溃（远程桌面 / 无显卡机器 / 容器）

在**无可用 GPU** 的环境里，Electron 可能直接报错退出：

```
FATAL:gpu_data_manager_impl_private.cc(449)] GPU process isn't usable. Goodbye.
```

（退出码 `2147483651`）

这是**环境 / 显卡驱动问题，不是本软件缺陷**。加参数启动即可避开：

```bash
npm start -- --disable-gpu
npx electron . --disable-gpu --in-process-gpu
```

### npm 安装极慢 / electron 二进制拉不下来

见「二、启动 → 国内网络加速」：`--registry=https://registry.npmmirror.com` **只解决 npm 包**；
electron 的**二进制**另外走 GitHub，**必须再设 `$env:ELECTRON_MIRROR`**，否则会出现
"243 个包都装好了，但缺 `node_modules\electron\dist\electron.exe`" 的情况（表现是 `npm start` 起不来）。

### 界面显示「未检测到已订阅套餐」

可能是：① 你确实没订阅任何套餐；② 已订阅但 **SSO 登录态失效**（约 47 小时过期）。
浮层下方有「重新登录」按钮，点它即执行 `arkcli auth login volc-sso`。

### 面板上某个计划显示「未订阅 X」，但控制台里明明有

确认手工执行的是 `arkcli usage plan --all --format json`（**带 `--all`**）。
不带 `--all` 时 CLI 只返回探测到的桶，会把已订阅的 Agent Plan 漏掉。

### 圆环盯的计划不是我想看的

单击桌面小图标（或托盘图标左键、托盘菜单里的「圆环显示」那一行）即可轮换。
选择会记到 `config.json` 的 `miniPlan`，下次启动沿用。

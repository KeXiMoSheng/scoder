# scoder

scoder（全称 **Super Coder**）是一款本地运行的 AI 编码桌面应用：以工作区为边界，把 AI 对话、代码编辑、文件管理与集成终端整合在同一个窗口里。

- `frontend/`：Electron + React + TypeScript 桌面端。AI 能力在 Electron 主进程内实现，通过 OpenAI 兼容接口直连模型服务；模型配置、API Key、会话与设置全部保存在本机。
- `backend/`：Flask API 服务（uv 管理依赖与环境），当前提供健康检查与连通性接口，桌面端运行不依赖它。

## 功能特性

### AI 编码助手

- 兼容 OpenAI `chat/completions` 协议，流式输出，可接入任意 OpenAI 兼容服务或本地模型
- 模型配置可增删改，支持从远程 `/models` 接口一键导入；可配置上下文窗口档位与思考深度（`reasoning_effort`）
- 内置工具调用：`read` / `list` / `glob` / `grep` / `bash` / `write` / `edit` / `todo_write`
- 文件读写工具限制在当前工作区内，写操作遵循“先读后改”；`bash` 固定工作目录并限制超时与输出上限
- 多会话：以 JSONL 持久化，支持标签页、历史列表、自动生成标题、单条 / 批量导出
- 上下文用量展示；单段步数用满后自动续接，连续重复调用会提醒直至中止；可随时中断本轮

### MCP 扩展工具

- 接入 Model Context Protocol 服务端：`stdio`（本机子进程）与 `streamable-http`（远程端点）两种连接方式
- 服务端工具以 `mcp__服务名__工具名` 注册给模型，服务端自述的使用说明随系统提示一起下发；断线按指数退避自动重连，重试预算耗尽后注销该服务端的工具
- 设置页「MCP 服务」支持增删改、启用/停用、测试连接与手动重连；可配置启动命令与参数、环境变量、请求头、工具调用超时与重连策略
- 当前只接入 MCP 的工具（tools）能力；resources、prompts、elicitation 与 OAuth 授权暂未支持

### 代码编辑

- Monaco 编辑器，多标签页，语法高亮，启动时恢复上次未关闭的页签
- 文本编码自动识别（UTF-8 / UTF-16 / GBK 等）并可手动切换，保存时按当前编码写回
- 大文本流式加载与流式保存，默认打开阈值为 1024 MB（设置页可调），避免整文件驻留内存
- 文件被外部修改时自动重载；AI 的改动支持行内 diff 查看

### 文件与工作区

- 文件树：目录监听自动刷新，支持新建 / 重命名 / 移动 / 删除 / 在系统文件管理器中显示
- Git 状态标记：项目处在 Git 仓库时，文件树在每行最右侧标出新增（A）、修改（M）、删除（D），文件名与标记按状态着色；目录按子孙文件聚合——子孙只有一种状态时沿用该状态，出现多种状态时统一显示修改（M），并同样显示状态标记。编辑器页签、AI 的「本轮改动」与「变更文件」清单使用同一套状态色。颜色取自主题的 `editorGutter.addedBackground` / `editorGutter.modifiedBackground` / `editorGutter.deletedBackground`，随主题切换。已删除的文件仍保留在树中，便于对照仓库状态。状态由主进程自动检测（默认每 2 秒一次，只在变化时推送），不需要手动刷新。标记只表示状态，不展示增删行数
- 基于 ripgrep 的递归文件搜索，默认跳过隐藏文件与被 ignore 的文件
- `Ctrl/Cmd+Shift+F` 全局搜索文件内容，`Ctrl/Cmd+Shift+R` 预览并替换当前搜索结果；双击 `Shift` 按名称快速打开文件（不拦截系统输入法切换）
- Markdown / SVG / 图片 / 音频 / 视频预览；AI 回复中的文件路径可点击跳转，支持行号与行号范围
- 最近打开项目（MRU）与启动恢复

### 集成终端

- 基于 node-pty + xterm.js 的终端面板，支持多页签与尺寸自适应
- Windows 下设置页会自动探测 PowerShell 7 并预填 `pwsh.exe` 路径；未保存路径时回退系统自带 5.1
- 终端复制 / 粘贴统一使用 `Ctrl+Shift+C` / `Ctrl+Shift+V`（macOS 为 `Cmd+Shift+C` / `Cmd+Shift+V`）

### 本地数据

- 模型配置与各项设置存于本地 SQLite（better-sqlite3），不依赖外部服务
- 会话日志与 AI 改动快照保存在 Electron `userData` 目录，不会上传到任何服务器

## 项目结构

```text
scoder/
├── backend/                 # Flask API 服务（uv）
│   ├── app/
│   │   ├── api/v1.py        # /api/v1 路由（健康检查、连通性测试）
│   │   ├── core/config.py   # 环境变量配置
│   │   └── main.py          # 应用入口
│   └── tests/
├── frontend/                # Electron 桌面端
│   ├── src/main/            # 主进程：AI 循环与工具、文件 / 终端、SQLite、IPC
│   ├── src/preload/         # 白名单 IPC 桥
│   ├── src/shared/          # 主进程与渲染进程共享的类型与通道常量
│   ├── src/renderer/        # React 界面（Monaco、xterm、Tailwind）
│   ├── build/               # 打包资源（应用图标、NSIS 安装脚本、entitlements）
│   └── scripts/             # 开发与打包脚本（dev / dist / 版本校验 / 文件图标查询 / MCP 冒烟）
├── Makefile                 # 开发、构建、打包的统一入口
└── README.md
```

## 技术栈

| 领域     | 选型                                                              |
| -------- | ----------------------------------------------------------------- |
| 桌面框架 | Electron 44、electron-vite 6                                     |
| 界面     | React 19、TypeScript 5.9、Tailwind CSS 4、Radix UI、lucide-react |
| 编辑器   | Monaco Editor                                                     |
| 终端     | node-pty、xterm.js                                                |
| 存储     | better-sqlite3（设置 / 模型）、JSONL（会话日志）                 |
| 文件能力 | @vscode/ripgrep（搜索）、jschardet + iconv-lite（编码识别转换）  |
| 后端     | Flask、uv（Python 3.12）                                         |
| 打包     | electron-builder（NSIS / AppImage / deb / dmg）                  |

## 环境要求

- Node.js >= 22.12 + npm（Vite 8 / Electron 44 的要求）
- Python >= 3.12 + [uv](https://docs.astral.sh/uv/)（仅后端需要）
- Windows / macOS / Linux
- Linux 下 `npm install` 会编译原生模块（如 node-pty），需预装 `build-essential` 与 `python3`
- Windows 可选安装 [PowerShell 7](https://github.com/PowerShell/PowerShell/releases/)；未安装时使用系统自带 5.1
- 在 Linux 上打 Windows 安装包需预装 wine 与 wine32（见[打包](#打包)）

## 快速开始

```bash
git clone https://github.com/KeXiMoSheng/scoder.git
cd scoder

make install      # 安装前后端依赖（uv sync + npm install）
make dev-desktop  # 启动桌面端开发模式
```

后端骨架服务仅在需要调试接口时启动，桌面端不依赖：

```bash
make dev-api      # http://127.0.0.1:39200
```

首次使用：

1. 打开「设置 → 模型」，添加一条 OpenAI 兼容的模型配置（服务地址、API Key、模型名、上下文窗口、思考深度）
2. 或使用「设置 → 一键导入模型」，从远程 `/models` 接口批量导入
3. 打开一个项目目录，在右侧 AI 面板开始对话

## 常用命令

| 命令                  | 说明                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `make install`        | 安装依赖（`uv sync` + `npm install`）                            |
| `make dev-api`        | 启动后端开发服务（热重载，默认 `127.0.0.1:39200`）               |
| `make dev-desktop`    | 启动桌面端开发模式（主进程 / preload / 渲染进程热重载）          |
| `make build`          | 构建前端产物到 `frontend/out`（后端为纯 Python，无构建步骤）     |
| `make test`           | 运行后端测试（pytest）                                           |
| `make lint`           | 后端 ruff + 前端版本一致性校验 + ESLint                          |
| `make release BUMP=patch` | 升级版本号并提交、打 tag（`patch` / `minor` / `major`）       |
| `make dist-win` / `dist-linux` / `dist-mac` | 打正式版安装包                              |
| `make dist-win-dev` 等 | 打开发版安装包（版本号追加 `-dev.<时间戳>`）                    |

前后端也可单独执行：

```bash
cd frontend
npm run typecheck   # 主进程 + 渲染进程类型检查
npm run lint        # ESLint
npm run format      # Prettier 格式化
```

```bash
cd backend
uv run pytest
uv run ruff check .
```

## 配置说明

### 后端环境变量

将 `backend/.env.example` 复制为 `backend/.env` 后按需修改：

| 变量           | 默认值      | 说明                            |
| -------------- | ----------- | ------------------------------- |
| `HOST`         | `127.0.0.1` | 监听地址                        |
| `PORT`         | `39200`     | 监听端口                        |
| `DEBUG`        | `true`      | 调试模式                        |
| `CORS_ORIGINS` | `*`         | 跨域白名单，逗号分隔，`*` 全放行 |

### 模型配置

- 服务地址填写 OpenAI 兼容的 base URL（如 `https://api.deepseek.com/v1`），实际请求发往 `<baseURL>/chat/completions`
- 上下文窗口仅用于本地用量统计，不会放进请求体；思考深度会作为 `reasoning_effort` 发送
- API Key 以明文保存在本地 SQLite 中，渲染进程仅在设置页编辑时使用；请勿把 `scoder.db` 分享给他人

### 编辑器与终端

- 编辑器默认提示打开超过 1024 MB 的文本文件，可在「设置 → 编辑器」调整；超大文件走流式加载与流式保存
- Windows 终端默认使用系统 PowerShell 5.1；安装 PowerShell 7 后，「设置 → 终端」会自动探测并预填 `pwsh.exe` 路径，确认保存后新终端即使用 PS7；「浏览…」会直接打开文件管理器并选中当前路径

### Git

- 默认使用系统 `PATH` 上的 `git`，装了 Git 的机器无需配置；打开「设置 → Git」时会自动探测并预填 git 可执行文件的绝对路径（使用当前系统的目录分隔符）
- 「浏览…」直接打开系统文件管理器并选中当前路径，与文件树的「在文件资源管理器中显示」共用同一套逻辑；Linux 下同样生效
- `PATH` 里没有 git 时，在「设置 → Git」中指定可执行文件的绝对路径（例如 `C:\Program Files\Git\cmd\git.exe`）；指定路径失效时自动回退到 `PATH`
- 「测试版本」会实际运行一次 `git --version` 并显示版本号，未保存的路径也可以先测试
- 文件树的 Git 标记使用同一个可执行文件；保存设置后下一次自动检测即生效

## 端口约定

统一使用 39xxx 段，避免与常见默认端口冲突：

| 端口  | 用途                               |
| ----- | ---------------------------------- |
| 39200 | 后端 API（`/api/v1`）              |
| 39273 | 渲染进程开发服务器（electron-vite） |

## 后端接口

| 方法  | 路径             | 说明                                                          |
| ----- | ---------------- | ------------------------------------------------------------- |
| `GET` | `/api/v1/health` | 健康检查，返回 `{"status":"ok","service":"ai-code-backend"}` |
| `GET` | `/api/v1/ping`   | 连通性测试，返回 `{"message":"pong"}`                        |

```bash
curl http://127.0.0.1:39200/api/v1/health
```

## 本地数据与文件位置

数据统一位于 Electron 的 `userData` 目录（Linux 通常为 `~/.config/scoder`，Windows 通常为 `%APPDATA%\scoder`，macOS 通常为 `~/Library/Application Support/scoder`）：

| 路径                                    | 内容                                                   |
| --------------------------------------- | ------------------------------------------------------ |
| `scoder.db`                             | SQLite：模型配置（`model_configs`）、应用设置（`app_settings`） |
| `sessions/<projectKey>/<sessionId>.jsonl` | AI 会话日志（追加式 JSONL）                          |
| `ai-change-snapshots/`                  | AI 改动前的文件快照，供行内 diff 使用                  |
| 导出目录（用户选择）                    | 会话导出文件，命名为 `<标题>_<yyyymmdd_HHMMSS>.jsonl`  |

## 打包

打包产物统一输出到 `frontend/dist/`，并使用 `scoder` 命名前缀：

| 命令               | 平台                     | 产物示例                                      |
| ------------------ | ------------------------ | --------------------------------------------- |
| `make dist-win`    | Windows                  | `scoder-<version>-setup.exe`（NSIS 向导式安装） |
| `make dist-linux`  | Linux                    | `scoder-<version>.AppImage`、`scoder_<version>_amd64.deb` |
| `make dist-mac`    | macOS（需在 macOS 上执行） | `scoder-<version>.dmg`                      |

- Windows 安装包可自定义安装路径，所选目录下会自动创建 `scoder` 子目录
- 安装包未配置代码签名与公证（`notarize: false`），Windows SmartScreen 或 macOS Gatekeeper 可能给出安全提示，需要手动放行
- 在 Linux 上执行 `make dist-win` 需预装 wine 与 wine32；`frontend/scripts/dist.mjs` 会自动补装目标平台的 ripgrep 二进制与 better-sqlite3 预编译文件
- 开发脚本 `frontend/scripts/dev.mjs` 会为 electron-vite 追加 `--noSandbox`，避免 Linux（尤其 root）环境下的 Chromium 沙箱限制

### 版本号与发布通道

- **正式版**（默认）：版本号取 `frontend/package.json` 的 `version`，发布前手动升级；命令为 `make dist-win` / `make dist-linux` / `make dist-mac`
- **开发版**：基础版本 + `-dev.<yyyymmddHHmm>` 时间戳（如 `1.0.0-dev.202610151701`），由 `frontend/scripts/dist.mjs` 在构建时自动注入，无需修改 `package.json`；命令为 `make dist-win-dev` 等（等价于 `make dist-win CHANNEL=dev`）
- 两种版本产物文件名不同，可并存于 `frontend/dist/`；deb 包内版本号会自动转换为 Debian 语义（`1.0.0~dev.<时间戳>`）

## 发布流程

```bash
# 1. 工作区必须干净（npm version 会检查），先提交功能改动
git add -A
git commit -m "支持 xxx"

# 2. 升版本：自动改写 package.json / package-lock.json，并 commit + tag（tag 不带 v 前缀）
make release BUMP=patch   # 或 minor / major

# 3. 推送代码与 tag，然后打包（产物名自动变成 scoder-<新版本>-setup.exe）
git push --follow-tags
make dist-linux CHANNEL=release
```

`npm run version:check`（已包含在 `make lint` 中）会校验 `package.json` 与 `package-lock.json` 的版本号是否一致；不要手改 `version` 字段。

## 说明

- `deepseek-harness/` 为本地参考的上游实现（内嵌 git 仓库，已在 `.gitignore` 中忽略、不随本仓库分发）；源码注释中“对齐 deepseek-harness”即指该参考实现
- 渲染进程只能通过 `preload` 暴露的白名单 IPC 方法访问系统能力；文件系统、终端、数据库与模型调用均在主进程执行

# scoder

scoder（全称 **Super Coder**）是一个 AI 代码生成工具，前后端分离、本地运行：桌面端负责界面交互，本地 API 服务负责代码生成能力，两端通过本机端口通信。

- `backend/`：Flask API 服务（uv 管理依赖与环境）
- `frontend/`：Electron + React + TypeScript 桌面端（electron-vite 构建）

## 环境要求

- Python >= 3.12 + [uv](https://docs.astral.sh/uv/)
- Node.js >= 20 + npm

## 快速开始

```bash
make install     # 安装前后端依赖
make dev-api     # 启动后端服务（http://127.0.0.1:39200）
make dev-desktop # 启动桌面端开发模式
```

## 常用命令

| 命令         | 说明                                        |
| ------------ | ------------------------------------------- |
| `make install` | 安装依赖（uv sync + npm install）           |
| `make dev-api` | 启动后端开发服务（热重载）                  |
| `make dev-desktop` | 启动桌面端开发模式（热重载）              |
| `make build`       | 构建前端产物到 `frontend/out`             |
| `make dist-win`    | 打包 Windows 安装包（NSIS 向导式安装）    |
| `make dist-linux`  | 打包 Linux 安装包（AppImage / deb）       |
| `make dist-mac`    | 打包 macOS 安装包（需在 macOS 上执行）    |
| `make dist-*-dev`  | 开发版打包（如 `make dist-win-dev`，版本号追加 `-dev.<时间戳>`） |
| `make test`        | 运行后端测试                              |
| `make lint`        | 前后端静态检查                            |

打包产物统一输出到 `frontend/dist/`，并统一使用 `scoder` 命名前缀（Windows 安装包如 `scoder-1.0.0-setup.exe`，Linux 产物如 `scoder-1.0.0.AppImage` / `scoder_1.0.0_amd64.deb`）。Windows 安装包为向导式安装，可自定义安装路径（用户选择的目录下会自动创建 `scoder` 子目录）。在 Linux 上执行 `make dist-win` 需预装 wine 与 wine32（electron-builder 通过 wine 运行安装器以提取并签名卸载器）。

## 版本号与发布通道

- **正式版**（默认）：版本号取 `frontend/package.json` 的 `version`，发布前手动升级；命令 `make dist-win` / `make dist-linux` / `make dist-mac`
- **开发版**：基础版本 + `-dev.<yyyymmddHHmm>` 时间戳（如 `1.0.0-dev.202610151701`），由 `frontend/scripts/dist.mjs` 在构建时自动注入，无需修改 package.json；命令 `make dist-win-dev` 等（等价于 `make dist-win CHANNEL=dev`）
- 两种版本产物文件名不同，可并存于 `frontend/dist/`；deb 包内版本号会自动转换为 Debian 语义（`1.0.0~dev.<时间戳>`）

## 端口约定

统一使用 39xxx 段，避免与常见默认端口冲突：

- 39200：后端 API
- 39273：前端渲染进程开发服务器

## 现有接口

- `GET /api/v1/health`：健康检查
- `GET /api/v1/ping`：连通性测试

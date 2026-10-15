.PHONY: install dev-api dev-desktop build dist-win dist-linux dist-mac dist-win-dev dist-linux-dev dist-mac-dev test lint

# 打包通道：release=正式版（版本号取 package.json 的 version）；dev=开发版（版本号追加 -dev.<时间戳>）
# 用法：make dist-win（正式版）或 make dist-win-dev / make dist-win CHANNEL=dev（开发版）
CHANNEL ?= release

# 安装前后端依赖（后端 uv，前端 npm）
install:
	cd backend && uv sync
	cd frontend && npm install

# 后端开发服务：Flask 热重载，接口统一挂在 /api/v1 下
dev-api:
	cd backend && uv run flask --app app.main run --debug --host 127.0.0.1 --port 39200

# 桌面端开发模式：electron-vite 同时为主进程与渲染进程提供热重载
dev-desktop:
	cd frontend && npm run dev

# 构建前端产物到 frontend/out（后端为纯 Python，无构建步骤）
build:
	cd frontend && npm run build

# 打包 Windows 安装包（NSIS，产物在 frontend/dist）
dist-win:
	cd frontend && BUILD_CHANNEL=$(CHANNEL) npm run build:win

# 打包 Linux 安装包（AppImage / deb）
dist-linux:
	cd frontend && BUILD_CHANNEL=$(CHANNEL) npm run build:linux

# 打包 macOS 安装包（需在 macOS 系统上执行）
dist-mac:
	cd frontend && BUILD_CHANNEL=$(CHANNEL) npm run build:mac

# 开发版打包快捷目标（等价于在对应命令后加 CHANNEL=dev）
dist-win-dev: CHANNEL=dev
dist-win-dev: dist-win
dist-linux-dev: CHANNEL=dev
dist-linux-dev: dist-linux
dist-mac-dev: CHANNEL=dev
dist-mac-dev: dist-mac

test:
	cd backend && uv run pytest

lint:
	cd backend && uv run ruff check .
	cd frontend && npm run lint

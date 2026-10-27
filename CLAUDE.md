# HoYoCalendar — 给 Claude 的项目说明

## 沟通习惯（必须遵守）

- **所有回复、总结、提问都用简体中文。** 用户看不懂英文说明；代码、命令、标识符保持原样。
- 用户习惯直接下指令（"直接连上去看看""帮我启动一下最新版"），希望你自己查清楚再动手，不要反复确认显而易见的事。
- 修改日程 Agent 工具时遵守 `AGENTS.md` 的五项同步规则（schema / 执行语义 / 客户端审批 / 回归测试 / OpenAPI）。
- 服务器 `.env` 含密钥，**不要读取或打印**；用户曾拒绝过读 `.env` 的命令。

## 版本与源码位置（先确认再动手）

- 用户日常使用的是**安装版**：`C:\Users\23676\AppData\Local\Programs\hoyocalendar\HoYoCalendarV<版本>.exe`。
- **最新源码**以安装版版本号为准，对照各目录的 `package.json` 里的 `version`：
  - `C:\Users\23676\.codex\worktrees\4d34\hoyoCalendar`（分支 `codex/sync-consistency`，2026-10-28 时为 v3.0.11，常有未提交改动）
  - `D:\vscodeprojects\hoyoCalendar` 是同一仓库的旧检出（`codex/v3.0.5`），**不是最新版**。
- 启动、开发、部署前先确认用的是最新目录，曾经因为在旧目录启动被用户指出"版本太老"。

## 项目结构

- Electron 桌面端：`main.js`、`preload.js`、`renderer.js`、`index.html`、`styles.css`、`src/core/*`（event-store、sync-engine、cloud-api 等）。
- 旧本地后端：`backend/`（Flask，`npm run test:backend`）。
- 云端后端：`cloud/`（FastAPI + PostgreSQL 16 + Alembic）。
  - 日程 Agent：`cloud/app/modules/agent/service.py`（`TOOL_DEFINITIONS`、`PlanningContext.execute()`、系统提示词）。
  - Agent 只"规划"动作，客户端审批卡片批准后才写入本地日历，再通过 receipts 回报服务器。
  - 模棱两可的新增请求用 `propose_event_options` 生成互斥候选，动作带 `choice_group_id` / `option_label`，客户端以单选呈现。
  - 修改/删除的 scope：`future` / `past` / `all` 通过拆分系列实现；`single` 只作用于某一天，
    存在循环/长期任务的 `occurrenceOverrides`（当天覆盖 event/time/location/note/urgency）和 `skippedDates`（跳过日）里。
    客户端 `event-store.js`、提醒 `reminder-scheduler.js` 与服务器 `_event_occurs_on` 的显示规则必须保持一致。
- 管理后台：`admin-web/`。

## 常用命令

```bash
# 启动（安装版在运行时需允许多实例，否则会被单实例锁直接退出）
HOYO_ALLOW_MULTIPLE_INSTANCES=1 npm start

# 前端/核心测试
node --test tests/*.test.js

# 旧本地后端测试
python -m unittest discover -s backend/tests -p "test_*.py"

# 重新生成 OpenAPI（cloud/ 下，需要 JWT_SECRET 等环境变量，用假值即可）
python scripts/generate_openapi.py
```

云端测试依赖 PostgreSQL 测试库，本机没有 Postgres。做法：把 `cloud/` 上传到服务器临时目录，
用 `/opt/hoyocalendar/venv/bin/python -m pytest tests -q` 跑（只会清空 `hoyocalendar_test` 库）。

## 服务器与部署

- SSH：`ssh -i ~/.ssh/hy.pem ubuntu@124.220.210.116`，ubuntu 用户可免密 sudo。
- 代码在 `/opt/hoyocalendar/cloud`，venv 在 `/opt/hoyocalendar/venv`，服务：`hoyocalendar-api`（:8000）、`hoyocalendar-admin`（:8001）、`hoyocalendar-admin-web`（:8080），全部只监听 127.0.0.1。
- 健康检查：`curl -s http://127.0.0.1:8000/healthz`。
- 部署流程（详见 `cloud/deploy/deploy.md`）：
  1. 先备份：`sudo cp -a /opt/hoyocalendar/cloud /opt/hoyocalendar/cloud-backup-<日期>-<说明>`。
  2. 上传到临时目录，用 `rsync -rcn --itemize-changes` 预演，并用 `diff --strip-trailing-cr` 核对真实差异（本地文件常是 CRLF）。
  3. **只覆盖确实需要更新的文件**。服务器上的 `deploy/deploy.md`、`nginx/hoyocalendar-api.conf`、`.env.example` 比仓库新（含 sslip.io HTTPS 配置），不要覆盖；也不要用 `--delete` 删掉服务器上的 `.bak` 文件。
  4. `sudo install -o hoyo -g hoyo` 放置文件，`sudo systemctl restart hoyocalendar-api hoyocalendar-admin`，再查健康检查和 `journalctl`。
- 回退：用备份目录 rsync 回 `/opt/hoyocalendar/cloud` 后重启服务。

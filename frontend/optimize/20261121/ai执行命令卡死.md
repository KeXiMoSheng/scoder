# AI 执行命令卡死：`bash` 工具的超时与「停止」都无效
涉及代码：[shell.ts](../../src/main/ai/tools/shell.ts)（工具执行）、[agentLoop.ts](../../src/main/ai/loop/agentLoop.ts)（调用方）、[main/ai/index.ts](../../src/main/ai/index.ts)（会话锁）。

## 一、现状

### 1.1 两次真实事故

| 时间 | 会话日志（仓库根目录） | 行号 | 命令 | `timeout_ms` | 结果 |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 10:57 | `费用核算维度配置缺失_20261119_105743.jsonl` | 349（文件末行） | `.\gradlew.bat :8b4t-cmhk-zh:compileJava --offline -q 2>&1 \| Select-Object -Last 40`，`workdir: cmssc` | 600000 | 没有 `tool/result` |
| 2026-11-20 11:52 | `MySQL例子免依赖直接用_20261120_115235.jsonl` | 134（文件末行） | `node verify-nodeps.mjs --mock 2>&1 \| Select-Object -Last 90` | 180000 | 没有 `tool/result` |

### 1.2 日志签名

两份日志的最后一条事件都是 `assistant/message` 里的 `bash` tool-call，之后**什么都没有**：没有 `tool/result`、没有 `step/end`、没有 `turn/end`。也就是说这一轮的日志停在「工具发出去」这一刻，收尾事件一个都没写。

两份日志里「有调用、无结果」的次数都恰好是 1，就是上面这两条（第一份 8 次 `bash` 调用，第二份 30 次）——不是模型乱发参数，也不是 `timeout_ms` 不合法，而是**工具调用永不结算**。

### 1.3 用户可见症状

1. 卡片永久「执行中」，没有任何输出（`2>&1 | Select-Object -Last N` 会把输出全缓存在管道里，命令不结束就一个字都不吐）；
2. 点停止按钮 / 按 Esc 没反应，再点也没反应（`AbortController.abort()` 对已中止的 controller 是空操作）；
3. `timeout_ms` 到点同样没反应——600 秒、180 秒都一样；
4. 该会话后续消息被拒：`该会话已有一轮对话正在执行`（[main/ai/index.ts:70](../../src/main/ai/index.ts#L70)）；
5. 只能重启应用；重启后这一轮在界面上是残缺的（缺 `step/end` 与 `turn/end`）。

### 1.4 影响范围

- **Windows 上必现**，前提只是「被杀的直接子进程还留着活着的子进程」；
- macOS / Linux 上极少见：旧代码对 POSIX 杀的是整个进程组（`detached: true` + `kill(-pid)`），组内一起死，`close` 正常到达；
- 与命令跑多久无关，只取决于进程树形状。`gradlew.bat`（powershell → cmd → java）、`node xxx.js`、`npm`、`psql` 这类都会中招；
- 反过来，`echo hi`、`git status` 这种没有后台子进程的命令从来没出过问题——这就是它长期没被发现的原因。

## 二、原因

### 2.1 暂停的完整链路（旧代码）

| 步骤 | 位置 |
| --- | --- |
| 点停止按钮 / 按 Esc | [AiComposer/index.tsx:225](../../src/renderer/src/components/AiComposer/index.tsx#L225)（Esc 在 :193） |
| 渲染进程发 IPC | [useAiChat.ts:216](../../src/renderer/src/hooks/useAiChat.ts#L216) → `window.api.ai.abort(sessionId)` |
| 预加载转发 | [preload/index.ts:38](../../src/preload/index.ts#L38) |
| 主进程触发 abort | [main/ai/index.ts:99](../../src/main/ai/index.ts#L99) → `running.get(sessionId)?.abort()`（controller 在 :73 创建） |
| 信号传进工具 | [agentLoop.ts:371](../../src/main/ai/loop/agentLoop.ts#L371) → [shell.ts:89](../../src/main/ai/tools/shell.ts#L89) → `runCommand(..., ctx.signal)` |
| 信号处理 | `runCommand` 里 `signal.addEventListener('abort', onAbort)` → `kill()` |

**信号一路都送到了，`signal.aborted` 也确实变成了 `true`。** 旧代码的 `kill()` 在 Windows 上只有一行：`child.kill('SIGKILL')`，等于 `TerminateProcess(powershell.exe)`——只结束直接子进程。
```
[scoder 的 Node 主进程]  ← 手里握着管道“读端”
 │
 └─ ① powershell.exe                      ← 直接子进程，就是 child.pid，旧代码只杀到它
      │
      └─ ② cmd.exe /c "...\gradlew.bat" :8b4t-cmhk-zh:compileJava --offline -q
           │                                ← .bat 必须由 cmd.exe 执行（PowerShell 5.1 内部就是起 cmd /c）
           │
           └─ ③ java.exe org.gradle.wrapper.GradleWrapperMain ...   ← gradlew.bat 里启动的 wrapper 客户端
                │
                ├─ ④ java.exe org.gradle.launcher.daemon.bootstrap.GradleDaemon   ← 常驻 daemon
                └─ ⑤ （可选）worker JVM / javac                                  ← Gradle 通常在 daemon 里就地编译，这层可能没有
一句话结论：**取消被实现成「杀进程 + 等 `close`」，而 `close` 等的不是进程死亡，是管道写端引用计数归零；Windows 上 `child.kill()` 只杀掉最外层那一个进程，所以 `close` 永远不来，`runCommand` 的 Promise 永远不结算，整轮对话连同停止按钮一起冻死。**
```
### 2.2 关键：`close` 等的是管道 EOF，不是进程死亡

Node 的两个事件语义不同：

- `exit`：**直接子进程**结束了（我们 spawn 的那一个）；
- `close`：子进程结束 **且** `stdout`/`stderr` 流都结束了（读端拿到 EOF）。两者是 `AND`。

而管道是内核对象，写端是**引用计数**：

```
spawn 时：  读端留在主进程（child.stdout）    写端复制一份给直接子进程（它的 stdout）
之后每层：  POSIX fork 复制 fd 表 / Windows CreateProcess 复制可继承句柄（bInheritHandles）
            → 每个子孙都多一份写端引用
kill 时：   只销毁被杀进程自己那份 → 计数 N 减 1，还有别人
```

实测（本机 POSIX，用 `setsid` 模拟「子孙不在被杀范围内」，与 Windows 情形等价）：

```
[   2ms] spawn：父进程读端 = socket:[6518441]，直接子进程 bash pid=1045860
[ 504ms] 只杀直接子进程
[ 504ms] exit 到达  code=null signal=SIGKILL      ← 进程确实死了，事件也到了
[1505ms] 孙进程 sleep 仍活着，fd1 = socket:[6518442]  ← 同一条管道的另一端
[3006ms] 杀掉孙进程
[3007ms] close 到达                                ← 晚 1 毫秒，就在最后一个写端关闭时
```

另一个更直观的对照：`bash -c 'setsid sleep 3 & echo started'` 里 bash **根本没被杀**，它是自己正常退出的（`exit@3ms code=0`），但 `close` 到 `3004ms` 才到——等于孙子 `sleep` 的寿命。可见 `close` 跟「谁死了」无关，跟「写端清零」有关。

反向的失真也存在：`bash -c 'setsid sleep 2 >/dev/null 2>&1 & echo hi'` 里孙进程把 stdout 重定向掉了、不再持有管道，于是 `exit@3ms / close@3ms`——命令的副作用还在后台跑，工具却已经判定「结束」。

### 2.3 三条路径共用同一个出口

```ts
const kill = () => { /* 旧版：只结束直接子进程 */ }
timers.timeout = setTimeout(() => { timedOut = true; kill() }, timeoutMs)   // 超时 → kill
signal.addEventListener('abort', onAbort)                                  // 中止 → kill
child.on('close', () => { resolve(...) })                                  // 唯一结算点
```

| 路径 | 做了什么 | 之后等什么 | 结果 |
| --- | --- | --- | --- |
| 正常结束 | 什么都不做 | `close` | 毫秒级 ✅ |
| 超时 | `kill()` 直接子进程 | `close` | 写端残留 → 无上界 ❌ |
| 用户点停止 | `kill()` 直接子进程 | `close` | 同上 ❌ |
| 启动失败 | `error` 分支 | 不等 | ✅ |

**所以「超时没用」和「暂停没用」不是两个 bug，是同一个 bug 的两个入口。** 实测（复刻旧逻辑，超时/中止都设为 500ms）：

```
超时 500ms：  503ms 触发 → 504ms kill → 504ms exit → 3006ms close（孙进程 3s 后才死）
中止 500ms：  502ms 触发 → 502ms kill → 503ms exit → 8004ms close（孙进程 8s 后才死）
```

规律：

> **实际返回时刻 = max(超时/中止触发的时刻, 最后一个写端消失的时刻)**

孙进程是常驻 daemon 时，等号右边是无穷大——这就是「一直卡死」。

### 2.4 为什么整轮对话一起冻住

```
runCommand 的 Promise 永不结算
  → registry.execute 不返回                 （agentLoop.ts:371）
  → agentLoop 的 catch 不执行（settleAbortedStep 不跑：没有「用户中止」的 tool/result、没有 step/end）
  → finally 不执行（turn/end 不写、也不 emit 'turn-end'）
  → 主进程 running 里仍持有该会话 → 后续消息被拒（main/ai/index.ts:70）
  → 渲染进程只在收到 turn-end 时 setRunning(false)（useAiChat.ts:332）→ spinner 永远在
```

### 2.5 为什么「只把杀进程改成杀整棵树」还不够

杀树能解决绝大多数情况，但 `close` 依然可能不来：

- POSIX 上 `setsid` 出去的进程已经不在我们的进程组里，杀不到；
- Windows 的 `taskkill /T` 只能沿**还活着的父链**遍历，中间某一层先死掉，它下面那批就成了不可达的孤儿；
- 句柄可能已被转交给完全无关的进程（double-fork 的守护进程）；
- `kill` 本身可能失败（权限、`taskkill` 缺失、pid 已被复用）。

所以修复必须同时给出**上界**，不能只靠「杀得干净」。

### 2.6 触发因素（解释为什么偏偏是这两次）

工具缺陷是必要条件，但要出现「永久卡死」还得命令自己长时间不退出：

- 案例 1：`node verify-nodeps.mjs --mock` 本身有两个 bug（`mock-mysql.mjs` 的「直接运行」守卫只判断文件名后缀，被 `import` 时也启动了一个监听 33306 的服务端且没人关闭 → 进程打印完「验证通过」也永不退出；挑战码可能含 `0x00` → 偶发「密码不匹配」）。**这是例子代码的问题，不是工具的**，但正是它让命令一直跑。
- 案例 2：`gradlew.bat` 首次 `--offline` 编译慢，且进程树很深（powershell → cmd → java → worker）。
- 两者都用了 `2>&1 | Select-Object -Last N`：PowerShell 这个 cmdlet **先全缓冲再输出**，长任务全程零输出，观感上就是「完全没反应」。

## 三、解决措施

### 3.1 改动清单（全部在 [shell.ts](../../src/main/ai/tools/shell.ts)）

1. **新增 `SETTLE_GRACE_MS = 1_000`**（[:18](../../src/main/ai/tools/shell.ts#L18)）：退出后等管道排空的上限。
2. **监听 `exit`**（[:258](../../src/main/ai/tools/shell.ts#L258)）：记录退出结果，并装一个 1 秒兜底结算——**直接子进程结束就等于命令主体结束**，不再无上界地等 `close`。
3. **`settle()` 成为唯一出口**（[:185](../../src/main/ai/tools/shell.ts#L185)）：`settled` 守卫 → `cleanup` → 先判 `signal.aborted`（中止优先，不把半截输出当成功）→ 没等到 `exit` 就如实标 `[signal: SIGKILL]` → 否则用真实退出码。
4. **`settleAfterGrace()`**（[:205](../../src/main/ai/tools/shell.ts#L205)）：`??=` 只装一次，先到的那次生效。
5. **`kill()` 改杀整棵树**（[:209](../../src/main/ai/tools/shell.ts#L209)）：Windows 走 `taskkill /T /F`，POSIX 保持进程组，再补一次 `child.kill` 兜底，末尾挂上 1 秒兜底结算。
6. **新增 `killWindowsTree()`**（[:285](../../src/main/ai/tools/shell.ts#L285)）：`taskkill /pid <pid> /T /F`，并注明「必须在直接子进程还没退出时调用」（父进程没了就找不到子树）。
7. **`cleanup()`**（[:178](../../src/main/ai/tools/shell.ts#L178)）：清掉两个计时器 + 摘掉 abort 监听（不摘的话每个工具调用都会在 controller 上留一个闭包，长会话里越积越多，还抓着已结束命令的输出字符串）。
8. **`close` 保留为快路径**（[:263](../../src/main/ai/tools/shell.ts#L263)）：正常命令仍然毫秒级返回。

### 3.2 设计取舍

- **为什么不在 `exit` 当场结算**：`exit` 到 `close` 之间管道里可能还有没读完的内核缓冲，立刻结算会丢命令最后几行（恰好是报错最集中的地方）。实测 2MB 输出在 `exit` 时已收全，但那只是调度运气，不能当作保证。
- **为什么不干脆用 `exit` 取代 `close`**：正常路径 `close` 更快也更完整（同毫秒），而且它能覆盖「命令自己 `> log` 后仍在前台等」这类情形。
- **为什么是 1 秒**：正常命令 `close` 与 `exit` 同毫秒，只有异常路径才吃满上限；1 秒足以覆盖正常排空，又不会让停止按钮迟迟没有反馈。
- **为什么杀树 + 兜底两个都要**：前者让正常路径快，后者保证任何路径都有上界（见 2.5）。

### 3.3 行为对照（同一套真实代码，改前 / 改后）

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 普通命令 `echo hi` | 5ms ✅ | 5ms ✅ |
| 超时 500ms + 孙进程持有管道 | 8s 内不返回（挂死） | 1003ms 抛「命令超时（超过 500ms）」 |
| 用户中止 + 孙进程持有管道 | 8s 内不返回（挂死） | 1002ms 按 aborted 收尾 |
| 超时 300ms + 前台一直不退出 | 挂死 | 302ms 返回，无残留进程 |
| 用户中止 + 前台一直不退出 | 挂死 | 202ms 返回 |
| 长输出（3 万字符） | 正常截断 | 正常截断（保留末尾 2 万字符） |

### 3.4 验证方式

- 用 rolldown 把**真实的** `shell.ts` 打成 ESM，直接驱动 `createBashTool().execute(...)`（`fs.resolve` 桩返回 workdir），对超时/中止/正常/长输出四种路径断言「是否在 1.5 秒内结算」；
- 复现脚本关键点：用 `setsid sleep 3600 & wait` 造「持有写端但不在被杀范围内」的子孙，等价于 Windows 上的行为；
- 静态检查：`tsc -p tsconfig.node.json --composite false`、`eslint src/main/ai/tools/shell.ts`、`prettier --check`，全过；
- 产物确认：`npm run build` 后 `out/main/index.js` 里能搜到 `taskkill` 与 `SETTLE_GRACE_MS`，说明修复已进包（主进程代码变了，必须重新构建或重启 `npm run dev` 才生效）。

## 四、遗留与后续

1. **`search.ts`（ripgrep）仍只监听 `close`**：rg 是叶子进程、自身有 30 秒协作超时，风险低；若要完全统一，可以把同样的「exit + 兜底结算」搬过去。
2. **`Select-Object -Last N` 全缓冲**：建议在工具描述里补一句「输出已按流保留末尾 2 万字符，不要再用 `Select-Object -Last` 之类会全缓冲的管道」；或引导模型把长任务输出写进日志文件。
3. **后台任务语义要文档化**：命令自己甩出去的 daemon（Gradle daemon、`start /b`、`&` + 重定向）不会被等待，工具会在管道干净后立即返回，这是预期行为。
4. **POSIX 逃逸进程（`setsid`）杀不到**：只保证工具调用返回，不保证孤儿被清理。
5. **没有后台任务能力**：scoder 的 `bash` 只有超时，没有 `run_in_background`；长命令目前只能「调小 `timeout_ms` + 需要时手动停」。
6. **历史会话自愈**：被强杀留下的未闭合轮次不用手工修——[store.ts:230](../../src/main/ai/session/store.ts#L230) 的 `settle()` 会补 `turn/end{reason:'interrupted'}`，[store.ts:422](../../src/main/ai/session/store.ts#L422) 的 `replay()` 会丢掉「有 `tool_call` 没结果」的调用，重新打开即可继续对话。

## 五、复现与回归脚本

```js
import { spawn } from 'node:child_process'

const t0 = Date.now()
const at = () => `${Date.now() - t0}ms`
const child = spawn('/bin/bash', ['-c', 'setsid sleep 3600 & wait'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

child.on('exit', () => console.log(`[${at()}] exit  到达（旧代码不监听）`))
child.on('close', () => console.log(`[${at()}] close 到达`))
setTimeout(() => {
  console.log(`[${at()}] 只杀直接子进程（等价于 Windows 的 child.kill）`)
  child.kill('SIGKILL')
}, 500)
```

- 旧逻辑（只听 `close`）：`exit` 在 500ms 到达，`close` 永不出现 → 复现卡死；
- 新逻辑：`exit` + 1 秒兜底 → 1.5 秒内必定结算。

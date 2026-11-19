# dshx-side-chat — 侧边对话

仿 Claude（桌面版 side chat / CLI `/btw`）的侧边对话：在右侧栏里顺手问一个小问题，**能看到主对话到现在为止的全部上下文，但问答不写回主对话**，不打断正在跑的任务。

## 用法

| 入口 | 说明 |
|---|---|
| `Ctrl+;`（mac `⌘;`） | 打开/聚焦本会话的侧边对话 |
| 输入框 `/btw 问题` | 打开侧边对话并在那里提问；问题**不会**发给主模型 |
| 右侧栏 `+` → 「侧边对话」卡片 | 同上 |
| **对话正文里右键** | 选中了文字：「在侧边对话中提问（引用选中）」/「复制」/「打开侧边对话」；没选中：「打开侧边对话」。选中的文字会以 `>` 引用放进侧边输入框，补一句问题即可发送 |
| 会话标题（面包屑）右键 | 「打开侧边对话」 |

右键正文时浏览器自带菜单被替换；需要原生菜单（如「检查元素」）时按住 **Shift** 再右键。链接、图片、文件引用等自带菜单的元素不受影响。

面板里：Enter 发送、Shift+Enter 换行、Esc/「停止」中断；「引用选中」把主对话里选中的文字作为 `>` 引用放进问题；顶部可选「跟随主对话」或换一个模型；「清空」清掉这段侧边问答。

## 机制

- 每次提问 = 一次独立的模型请求：`主对话 deriveMessages()`（系统提示 + 全部消息和工具结果，与主循环下一步要发的完全相同）+ 之前的侧边问答 + 新问题。
- 默认沿用主对话的 provider / model / 推理强度和工具声明（为了请求合法、并尽量命中提供方的前缀缓存）；侧边模型被告知不能调用工具，即使它发出工具调用也只会被丢弃、**从不执行**。
- 主对话正在跑工具时，未完成的那一步（有调用没结果）会被裁掉再发。
- 请求不带 `sessionId`（避免订阅类 provider 与主对话正在进行的请求冲突）。
- **主会话日志零写入**；`/btw` 本身会像所有宿主命令一样在转录里留一行命令记录（`recordInput: false`，问题原文不入日志），但它不是模型可见内容。
- 侧边问答只存在浏览器 `localStorage`（`dshx-side-chat.v1.<sessionId>`，最多 50 轮），不跨设备。

## 配置（`cordis.patch.yml` 的 `dshx-side-chat` 条目 `config:`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxSideTurns` | 20 | 每次提问带上的之前侧边问答轮数 |
| `maxOutputTokens` | 0 | 侧边回答输出上限，0 = 跟随主对话/模型默认 |
| `requestTimeoutSeconds` | 600 | 单次提问超时 |

## 路由

- `POST /dshx-side-chat/ask` `{ sessionId, question, history?, provider?, model? }` → NDJSON 流 `meta / thinking / text / done / error`
- `GET /dshx-side-chat/models`
- `GET /dshx-side-chat/pending?sessionId=`（取走 `/btw` 排队的问题）

## 安装 / 更新

退出 DSH 后：`node install-profile.mjs`（`--dry-run` 预览）。三处登记（node_modules 副本、package.json 依赖+bundles、profile `cordis.patch.yml` 显式条目）一次做完，带备份与 BOM 检查。
回滚：从 profile `package.json` 的 `bundles` 删掉 `dshx-side-chat`，或还原 `*.bak-side-chat-*`。

## 测试

```
cd test
node host-test.mjs     # 20 项：历史裁剪、组装、/btw 排队、ask 流式端到端、主会话零写入
node client-test.mjs   # 23 项：tab 类型/槽位、/btw、Ctrl+;、面板渲染、正文右键（选中/未选中/Shift/链接）、标题右键
```
`test/node_modules` 是用 `extract-host.cjs` 从本机 `app.asar` 抽出的真 `@deepseek-ai/dsh-llm`（0.2.2-rc.1）。

## Model Experience

### 侧边提问请求

#### What the Model Sees

主对话完整派生历史 + 每个侧边问题前的一段固定框架文本（见 `index.js` 的 `FRAME`），要求只回答侧边问题、不继续主任务、不调用工具、用提问语言简洁作答。

#### Token Impact

每次提问都重新发送整段主对话历史，输入 token ≈ 主对话当前上下文 + 侧边问答；主对话本身 token 不变。

#### KV Cache Impact

独立请求。走主对话同一模型时，前缀（系统提示 + 历史 + 工具声明）与主循环一致，可命中提供方前缀缓存；换模型或主对话有未完成工具步时前缀会在末尾附近分叉。主对话的缓存前缀不受影响。

## Known Limitations

- **侧边对话不能用工具**（与 Claude 的 `/btw` 一致）；需要读新文件请回主对话。
- **记录只在本浏览器**，DSH 换浏览器/清缓存即丢失（与 Claude 桌面版「退出即丢」类似）。
- 正文右键走宿主的 `uiConversation.interactions`（`trigger: 'contextmenu'`）+ `conversation.chat.text-interaction` 浮层，是 Chat 区域自带的「选区/右键操作」通道（官方「引用文本」按钮用的同一套，只是它只认左键选区）。
- 宿主升级后要复查：`sidebarRightTabs.register` / `openTabFromTarget` / `shortcuts.register` 的形状、`session.requestHeader()` 与 `toolHistory()`、`command/executed` 客户端事件。

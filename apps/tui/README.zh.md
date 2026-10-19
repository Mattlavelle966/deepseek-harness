# 终端前端

[English](README.md) | 中文

`tui` profile 为现有 Web harness 提供键盘和鼠标操作界面。Web 与 TUI 共享后端的会话、工具、设置、审批和持久化。终端前端不启动服务器，也不加载另一个模型运行时。

## 运行

先单独运行 `dsh web --no-open`，然后在 Linux 终端或 tmux 窗格中运行：

```sh
dsh tui --url http://127.0.0.1:3032
```

端口必须与现有服务器一致。省略 `--url` 时使用 `DSH_TUI_URL`。TUI 使用仅限本机的连接握手，无需令牌。Harness 必须包含本机 TUI 认证支持；旧服务器更新后需要重启。`--session <id>` 选择现有会话；`--no-mouse` 将鼠标事件留给 tmux。服务器不可达、握手不兼容或没有交互终端时，会输出可操作的错误信息并退出。

连接远程 harness 时，先通过 SSH 转发端口，再提供本机转发 URL。应用挂载前缀保持不变。本机 TUI 握手仅接受来自 loopback socket 的连接。

在源码仓库中，先运行 `pnpm run build:artifacts`，再运行 `pnpm dsh tui --url <url>`。前端使用现有 Cordis 技术栈中的 Node 和 TypeScript。

## 导航

界面以 Normal 模式启动。`i` 或 `a` 进入内置多行编辑器；Escape 返回 Normal 模式。方向键和 `hjkl` 用于移动，`w/b` 按单词移动，`0/$` 移到行首或行尾，`gg/G` 移到开头或末尾，Ctrl-u/Ctrl-d 滚动。编辑器支持撤销/重做、`v` 选择、复制/删除和粘贴。括号粘贴中的换行与命令文本保持原样，不会提交提示或执行命令。

Tab 和 Shift-Tab 轮换焦点。Ctrl-w 后接 `h/j/k/l` 切换窗格。连续按两次空格打开可搜索的操作面板；`:` 输入 TUI 命令，`/` 搜索可见记录，`?` 打开帮助。菜单通过方向键和 Enter 操作，输入文字可过滤菜单项。表单使用 Tab 切换字段，Ctrl-s 提交。复杂参数接受 JSON，并由现有生成的编解码器验证。

Enter 按后端保存的忙碌状态偏好提交提示；Alt-Enter 使用相反的投递方式。Ctrl-j 插入换行。以斜杠开头的提示调用 harness 命令。草稿和附件按会话保存在当前前端本地。鼠标支持焦点切换、列表、滚动、窗格调整和记录选择；`:copy` 通过终端剪贴板协议复制选中的文字。剪贴板支持取决于终端和 tmux 配置。

## 工作流

| 命令 | 行为 |
| --- | --- |
| `:sessions`、`:new <主机目录>`、`:rename <标题>` | 浏览、创建或重命名共享会话 |
| `:fork`、`:older`、`:stop`、`:search <文本>` | 分叉、加载较早记录、停止当前轮次或搜索会话 |
| `:files` | 浏览主机工作区文件并预览文本 |
| `:settings`、`:models`、`:workspaces` | 打开现有控制器提供的操作 |
| `:plugins`、`:goals`、`:schedules`、`:jobs`、`:subagents`、`:commands` | 浏览对应功能的操作 |
| `:actions` | 浏览共享 Remote 门面选中的全部方法及扩展操作 |
| `:attach <本地路径>`、`:image <本地路径>` | 为当前草稿准备文件或图片附件 |
| `:clearattachments` | 清除草稿附件 |
| `:terminal`、`:terminals`、`:terminal <id>` | 创建或连接保留的 harness 终端 |
| `:terminalinput`、`:termdetach`、`:termclose` | 进入终端输入、断开视图或显式关闭远程终端 |
| `:export <本地路径.zip>` | 下载完整的原生会话归档 |
| `:transcript <本地路径>` | 保存已加载的文本记录 |
| `:download <路由> <本地路径>` | 保存经过身份验证的 harness 下载 |
| `:open <URL>` | 显式使用系统查看器打开可视内容 |
| `:questions` | 回答前台等待结束后仍待处理的 agent 提问 |
| `:inspect`、`:result` | 查看会话状态或最近一次操作结果 |
| `:reconnect`、`:cancelobservation`、`:mouse`、`:q` | 重连、停止操作流、切换鼠标或断开连接 |

审批和 agent 提问会同时显示在两个前端中。现有 gateway 接受最先提交的回答，并撤销另一份提示。Escape 将请求交给其他前端，不表示批准。支持自由文本和选项回答；多选回答可使用逗号分隔的选项标签。

保留的终端复用现有客户端终端控制器，实现保留、重连、输入确认和背压。Ctrl-反斜杠返回 TUI 导航。断开或退出 TUI 不发送终端或 agent 关闭命令；`:termclose` 才显式关闭终端。

Profile overlay 可在 `tui` 条目中配置 `frameMs`、`escapeDelayMs`、`connectTimeoutMs`、`maxStreamCharacters` 和鼠标默认值。连接中断时保留草稿，并使用现有恢复服务。结果未知的修改不会自动重放。

## 扩展 API

插件注入 `tui` 后，通过 `registerAction()` 注册 `TuiAction`，或通过 `registerRenderer(kind, renderer)` 注册渲染器。两者均返回精确的撤销函数，插件通过 `ctx.effect()` 管理注册。渲染器接收共享 Chat 数据并返回文本行。未知 Chat 类型仍显示结构化回退内容。

## 模型体验

TUI 提交与 Web 客户端相同的提示、附件、命令调用和交互回答，不改变模型请求、工具、沙箱策略或会话格式。

### KV Cache 影响

除用户正常执行的会话操作外没有影响；前端不增加模型可见上下文或提示变化。

## 已知限制与后续工作

支持 Linux，包括 tmux 和 SSH 端口转发。浏览器页面、图片和 Office/PDF 预览使用显式的外部查看器或下载。任意第三方 DOM 组件需要终端渲染器。内置编辑器提供模态导航和常用编辑操作，不实现完整的 Neovim 命令语言。扩展管理工作流使用生成的操作表单，不复制浏览器布局。草稿仅保存在当前进程中，不与浏览器本地草稿同步。

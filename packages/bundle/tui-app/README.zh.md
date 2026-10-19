---
description: "连接现有 Web harness 的终端 profile 组合包。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-tui-app`

[English](README.md) | 中文

## 概述

内置 `tui` profile 仅包含此组合包。其 patch 挂载 `@deepseek-ai/dsh-tui-frontend`，通过经过身份验证的 API 连接现有 Web harness。它不挂载模型运行时、工具、持久化提供方或 HTTP 监听器。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

单独启动 Web harness 后，运行 `dsh tui --url <localhost-url>`。前端使用无需令牌的本机连接握手。旧版 Harness 进程需要更新并重启才能支持。SSH 转发、模态编辑、鼠标导航、共享功能操作和终端保留见[终端指南](../../../apps/tui/README.zh.md)。

<a id="model-experience"></a>
## 模型体验

### 现有实例上的操作

#### 模型看到什么

用户提示（例如 `Explain this change.`）、附件、命令和交互回答通过 API 进入现有 harness。前端不增加模型可见上下文。

#### Token 影响

只有用户选择的现有 harness 操作消耗模型 token；连接和渲染不消耗 token。

#### KV Cache 影响

此组合包不改变模型请求或缓存键。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 需要已运行且兼容的 Web harness；此 profile 从不启动服务器。
- 支持 Linux 终端。可视预览使用显式的外部查看器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

此 profile 不包含 `dsh-base`；挂载该组合包会创建第二个后端，而不是连接前端。

</details>

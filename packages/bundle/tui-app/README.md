---
description: "Attach-only terminal profile bundle for an existing Web harness."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-tui-app`

English | [中文](README.zh.md)

## Summary

The shipped `tui` profile contains this bundle alone. Its patch mounts `@deepseek-ai/dsh-tui-frontend`, an authenticated API client for an existing Web harness. It mounts no model runtime, tools, persistence provider, or HTTP listener.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Run `dsh tui --url <localhost-url>` after starting a Web harness separately. The frontend uses a tokenless local attach handshake. Older Harness processes need an update and restart to support it. See the [terminal guide](../../../apps/tui/README.md) for SSH forwarding, modal editing, mouse navigation, shared feature actions, and terminal retention.

## Model Experience

### Actions on an existing instance

#### What the model sees

User prompts such as `Explain this change.`, attachments, commands, and interaction answers enter the existing harness through its API. The frontend contributes no additional model-visible context.

#### Token effect

Only the existing harness actions selected by the user consume model tokens; connecting and rendering consume none.

#### KV Cache effect

The bundle does not alter model requests or cache keys.

## Known Limitations and Deferred Work

- A running compatible Web harness is required; this profile never starts one.
- Linux terminals are supported. Graphical previews use explicit external viewers.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The profile excludes `dsh-base`; mounting that bundle would create a second backend instead of attaching a frontend.

</details>

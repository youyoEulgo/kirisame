# Margatroid UI

这是 Margatroid 的 Web 工作台，使用 Vue 3、Vite、Pinia 和 Bun。它直接连接 daemon 的 WebSocket，
不依赖旧 `kirisame` 的 HTTP、SSE 或任务板 API。

## 启动

```sh
bun install
bun dev
```

默认地址是 `http://127.0.0.1:5173/`。daemon 默认 WebSocket 地址是
`ws://127.0.0.1:3939/ws`，可以在界面里的 Connection 设置中修改。

```sh
cargo run -p margatroid_daemon -- --data-root ~/.margatroid
```

Workspace 文件仍由 CLI 编译并发送：

```sh
cargo run -p margatroid_cli -- workspace up ../demo_workspace/margatroid-workspace.yaml
```

UI 会监听 `workspace.started`，记录 Workspace 的 manager 和 Agent 列表。也可以手动添加一个已经
运行的 Workspace 引用；这不会重新启动 Workspace，只保存名称和项目根目录供消息路由使用。

## 协议

发送用户消息时，选中的普通 Agent 会写入 `agent`；选中 manager 路由时发送 `agent: null`，由 daemon
查询 Workspace.manager。daemon 返回的 `agent.message` 携带已经解析出的 Agent 名称，消息内容使用
`margatroid_types::Message` 的 serde 枚举形状。运行日志和推理失败分别显示在 Activity 面板和对话中。

## 检查

```sh
bun run type-check
bun run build
bun x eslint src --max-warnings=0
bun x oxlint .
```

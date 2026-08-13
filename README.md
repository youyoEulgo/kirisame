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

UI 使用 daemon 的 `state.sync` 快照维护 Workspace、Agent动态可见资源和对话历史。对话历史来自后端
各 Agent SQLite 的 `history_messages`，其中只包含可展示内容；用于模型上下文恢复的
`realtime_messages` 不会发送给 UI。Workspace、Agent、可见资源和工具调用统一使用完整ResourceId；
当前选中Agent的可用Skill来自其`visible_resources`中以`skill:`开头的资源。

UI 不使用 `localStorage`、`sessionStorage` 或其他持久化机制保存业务状态，不对发送中的消息做乐观
追加，也不从 `agent.message` 自行拼接历史。每次 `state.sync` 都会整体替换当前 Workspace 和对话视图，
页面刷新、daemon 重启或数据库删除后的显示结果完全以后端快照为准。

## 协议

发送用户消息时，选中的普通 Agent 会写入 `agent`；选中 manager 路由时发送 `agent: null`，由 daemon
查询 Workspace.manager。daemon 返回的 `agent.message` 携带已经解析出的 Agent 名称，但 UI 不将它
直接写入对话；对话只消费后续 `state.sync.histories`。运行日志和 Agent/Inference 轮次失败显示在
Activity 面板。

## 检查

```sh
bun run type-check
bun run build
bun x eslint src --max-warnings=0
bun x oxlint .
```

# qzone-mcp

[QQ 空间](https://qzone.qq.com) 操作的 [MCP](https://modelcontextprotocol.io) 服务器。

**减少扫码频率** —— 持久化浏览器登录态，Cookie 过期时自动从浏览器刷新，大部分情况下无需重新扫码。

## 功能

| 工具 | 说明 |
|---|---|
| `qzone_login` | 扫码登录（仅在登录态完全过期时需要） |
| `qzone_get_feed_list` | 获取指定 QQ 号的说说列表 |
| `qzone_comment_feed` | 对指定说说发表评论 |

## 工作原理

```
首次使用 → 扫码登录 → 登录态保存到 user_data/
    ↓
平时调用 → 用 Cookie 调 API（快、不弹浏览器）
    ↓
Cookie 过期 → 自动启动浏览器刷新 Cookie（通常无需扫码）
    ↓
浏览器也过期 → 提示调用 qzone_login 扫码
```

## 安装

```bash
git clone https://github.com/你的用户名/qzone-mcp.git
cd qzone-mcp
npm install
```

需要 Node.js >= 18。

## 配置 MCP 客户端

```json
{
  "mcpServers": {
    "qzone": {
      "command": "node",
      "args": ["/path/to/qzone-mcp/src/index.js"],
      "cwd": "/path/to/qzone-mcp"
    }
  }
}
```

## 使用

1. 调用任意工具（如 `qzone_get_feed_list`），首次会自动弹浏览器扫码
2. 之后 Cookie 过期时自动刷新，通常不需要重新扫码
3. 仅当登录态完全过期时，才需要调用 `qzone_login` 重新扫码

## 项目结构

```
qzone-mcp/
├── src/index.js     # MCP 服务器
├── config.json      # Cookie 配置（自动生成，不提交）
├── user_data/       # 浏览器登录态（自动生成，不提交）
├── package.json
└── README.md
```

## 注意事项

- 本项目仅供学习交流使用
- `config.json` 和 `user_data/` 包含登录态，切勿分享（已在 `.gitignore` 中排除）
- 频繁评论可能触发 QQ 空间风控

## License

MIT

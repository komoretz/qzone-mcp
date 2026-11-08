# qzone-mcp

[QQ 空间](https://qzone.qq.com) 操作的 [MCP](https://modelcontextprotocol.io) 服务器。

**无需扫码** —— 通过 CDP 连接已登录的 Edge 浏览器，实时提取 Cookie，只要 Edge 开着就能一直用。

## 功能

| 工具 | 说明 |
|---|---|
| `qzone_check_login` | 检查 Edge 登录状态 |
| `qzone_get_feed_list` | 获取指定 QQ 号的说说列表 |
| `qzone_comment_feed` | 对指定说说发表评论 |

## 工作原理

```
Edge 用 --remote-debugging-port=9222 启动
    ↓
在 Edge 里登录 QQ 空间
    ↓
MCP 工具通过 CDP 实时提取 Cookie（含 p_skey）
    ↓
调用 QQ 空间 API
```

只要 Edge 不关闭且登录态有效，就**完全不用扫码**。

## 安装

```bash
git clone https://github.com/komoretz/qzone-mcp.git
cd qzone-mcp
npm install
```

需要 Node.js >= 18。

## 使用步骤

### 1. 用调试端口启动 Edge

**先关闭所有 Edge 窗口**，然后双击 `start-edge.bat`，或运行：

```bash
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="edge-profile"
```

> 必须用 `--user-data-dir` 指定独立目录，否则调试端口不会生效（会复用已有 Edge 进程）。

### 2. 登录 QQ 空间

在弹出的 Edge 里访问 `https://user.qzone.qq.com` 并登录。

### 3. 配置 MCP 客户端

将 `/path/to/qzone-mcp` 替换为你的实际路径。

#### Claude Desktop

编辑 `%APPDATA%\Claude\claude_desktop_config.json`：

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

#### Cursor

设置 → MCP → 添加服务器，填入同上配置。

#### VS Code (Continue)

编辑 `.continue/config.json`：

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

#### Trae

设置 → MCP → 添加 MCP 服务器，命令为 `node`，参数为 index.js 的路径。

> Windows 路径用正斜杠 `/` 或双反斜杠 `\\`。

### 4. 使用工具

- 先调用 `qzone_check_login` 确认登录状态
- 调用 `qzone_get_feed_list` 获取说说列表（拿到 `tid`）
- 调用 `qzone_comment_feed` 发表评论

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `QZONE_CDP` | `http://localhost:9222` | Edge CDP 调试端口地址 |

## 常见问题

**Q: 9222 端口连不上？**
A: 确保所有 Edge 窗口已关闭，再用 `start-edge.bat` 启动。

**Q: 提示未找到 p_skey？**
A: 在 Edge 里访问 `https://user.qzone.qq.com` 并登录 QQ 空间。

**Q: 需要每次都扫码吗？**
A: 不需要。只要 Edge 开着且登录了 QQ 空间，就一直能用。

## 项目结构

```
qzone-mcp/
├── src/index.js        # MCP 服务器主文件
├── start-edge.bat      # 启动 Edge 调试模式的脚本
├── extract_cookies.py  # 可选：从 Edge 提取 Cookie 的辅助脚本
├── package.json
├── config.json         # Cookie 缓存（自动生成，不提交）
├── edge-profile/       # Edge 用户数据（不提交）
└── README.md
```

## 许可证

MIT

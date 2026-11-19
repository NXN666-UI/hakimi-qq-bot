# Hakimi QQ Bot

一个独立运行的 Node.js QQ 聊天机器人框架：通过本机 OneBot v11 WebSocket 接收消息，通过兼容 OpenAI Chat Completions 的接口调用模型。

公开版仅含框架、通用模板和模拟测试，不含作者自用人设、QQ账号、密钥、记忆、聊天记录、角色图片或桥接登录数据。无需 DSH / SurfCore。QQ桥接须由使用者另行准备，本项目不安装或改动桥接。

## 功能

- 群白名单、@/称呼/引用唤醒，固定时长续聊，合并连续消息；管理员私聊与闭麦/恢复。
- 自备三档模型：首选→次选→保底；故障冷却、自动降级、到期后在下一轮重试高优先级。
- 本地网页设置、实时模型请求状态、读取当前Key可见的上游模型列表（目录不等于健康检测）。
- SQLite自主印象表：群池最多30个QQ、每QQ跨群30条，7/15/30天遗忘；群和私聊正文隔离。
- 可选图片理解、自备表情库、按需搜索；本地缓存和数据跟随项目目录。
- 默认普通群友每天合计100次、北京时间0点重置；管理员免本地额度，调用仍会由模型服务商计费。

## 快速开始（Windows）

1. 安装官方 Node.js 24或更高版本，或准备便携版 `node.exe`。
2. 克隆到空间充足的目录，再执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1`；也可双击「初始化项目.cmd」。便携版用 `-NodePath "你的node.exe完整路径"`。脚本只复制运行时和初始化本项目文件，不会安装或启动QQ桥接。
3. 编辑本地 `config.json`：填写字符串形式的 `botQQ`、`ownerQQ`、`allowedGroups`，设置自己的 `onebot.wsUrl`、模型接口 `llm.baseUrl` 和实际模型ID。示例域名不能直接调用。`protectedPorts` 用来保留其他机器人的端口，可以按自己的部署调整。
4. 编辑本地 `.env`：`HAKIMI_API_KEY` 是模型服务的Key；`HAKIMI_ONEBOT_TOKEN` 是自己桥接的访问口令，二者不是同一个东西。
5. 编辑自己的 `persona.md`。初次初始化只从中性的 `persona.example.md` 复制，不附带作者角色。
6. 登录自己的机器人QQ、加入测试群，并启动自己的本机 OneBot v11 正向WebSocket桥接。默认地址 `ws://127.0.0.1:3011/`，账号必须与配置匹配。
7. 双击「检查配置.cmd」「检查小号连接.cmd」，再用「启动哈基米.cmd」或「哈基米控制台.cmd」。

双击「打开哈基米设置.cmd」可管理本地网页，默认 `http://127.0.0.1:17863`。参数修改后保存并重启；仅修改人设下一轮自动读取。多个项目不要同时占用这个网页端口。

## 命令行

已安装 Node.js 时无需 `npm install`，项目没有第三方运行依赖。

```powershell
npm test
npm run check
npm start
npm run settings
```

`check` 只做离线校验；模板账号/Key未填时失败属于正常。`test` 仅使用模拟HTTP/WebSocket，不调用真实模型或发QQ消息。Windows控制菜单依赖PowerShell；其他系统可直接使用Node命令运行聊天和网页，网页中的Windows启停按钮不适用。

## 隐私与自定义

`persona.md`、`config.json`、`.env`、`data/`、`logs/`、`runtime/`、`test-output/` 默认被Git忽略。不要通过 `git add -f` 提交它们。运行时规则在 `src/runtime-rules.mjs`，角色层在个人 `persona.md`，账号权限与闭麦还由程序校验。提示词不是绝对的隐私保证，部署前请自行核对群白名单、管理员账号和渠道的数据处理方式。

表情素材需自备，分类参见 `assets/stickers/README.md`。公开版没有作者专用账号安装脚本、历史审稿/联调脚本或自定义角色图库。

详细说明见 [操作手册](docs/操作手册.md)。代码使用 MIT 许可证；Node.js、QQ桥接、模型服务不包含在本项目授权内。

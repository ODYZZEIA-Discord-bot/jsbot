# Discord.js Bot Project

## 本地使用

将 `config.json` 放在根目录下, 将 `messageIds.json` 放在 `data` 文件夹下，如果不存在，则创建一个 `data` 文件夹。

 - `config.json` 的格式请参考 `config.example.json`，里面需要填入 bot-token 等内容。不需要的模块将 `enabled` 设置为 `false` 即可。
 - `messageIds.json` 的格式请参考 `messageIds.example.json`。

注意：由于 `discord.js` 的限制，在 Windows 下必须开启 TUN 的代理模式，才能正常运行。

安装 pnpm:

```bash
npm -g pnpm
```

用 pnpm 安装依赖包并运行:

```bash
pnpm install
pnpm start
```

## Linux上配合PM2使用

1. 确保已安装Node.js
```bash
# 到项目目录

# 安装pnpm
npm install -g pnpm

# 安装PM2
npm install -g pm2
```

2. 使用脚本启动机器人
```bash
# 添加执行权限
chmod +x start.sh update.sh monitor.sh

# 启动BOT
./start.sh

# 更新BOT
./update.sh

# 停止
pm2 stop discord-bot
```

3. 管理机器人
```bash
# 后台运行监控脚本
./monitor.sh &

# 查看日志
pm2 logs discord-bot --lines 200

# 查看状态
pm2 status
```

## 参与贡献

本项目采用 JavaScript 编写, 项目整体为自建架构, 因而有如下文件结构:

```txt
..
├── index.js  # 总入口, 读取配置文件, 完成命令、事件的加载, 启动 bot 客户端
│
├── events  # 监听 discord 事件, 执行对应操作
│   ├── guildMemberAdd.js     # 有新成员加入服务器时, 检测他是否是以前加入封禁列表但还没实际封禁的成员, 执行封禁操作
│   ├── interactionCreate.js  # 有人通过按钮、模态框等与 bot 发生交互, 将会分发给 handlers 进行处理
│   └── ready.js              # bot 客户端准备就绪
│
├── commands  # 各身份组可使用的 discord 命令
│               - 如果命令较为简单则直接编写, 否则在 services 中处理逻辑, 在此处调用对应函数
│               - 使用 try-catch 进行错误处理, 所有异步操作都应用 try-catch 包装
│               - 考虑用 globalBatchProcessor 处理批量操作, 用 globalRequestQueue 控制 API 请求频率
│   ├── adm_*.js   # 管理员 (优先级 5)
│   ├── mod_*.js   # 版主 (优先级 4)
│   ├── user_*.js  # 普通用户 (优先级 3)
│   └── long_*.js  # 长期执行的后台命令 (优先级 2)
│
├── handlers  # 处理交互
│   ├── buttons.js    # 处理按钮交互
│   ├── modals.js     # 处理模态框交互
│   └── scheduler.js  # 处理定时任务
│
├── services  # 对于较为复杂的命令, 在此编写处理逻辑
│   ├── courtService.js  # 流程系统服务
    ├── monitorService.js # 系统监控服务
│   ├── punishmentService.js  # 处罚系统服务
│   ├── roleApplication.js  # 身份组管理服务
│   ├── threadAnalyzer.js  # 活跃子区管理服务
│   ├── threadCleaner.js  # 子区人数清理服务
│   └── voteService.js  # 投票系统服务
│
├── db  # 存取数据库, 数据文件将存储于 data/database.sqlite 中
│   ├── dbManager.js  # 对数据库建表、查询等操作的封装, 目前的建表是直接以 SQL 形式硬编码在代码中
│   └── models        # 对各表存取的封装
│       ├── processModel.js     # 议事流程记录
│       ├── punishmentModel.js  # 成员处罚记录
│       └── voteModel.js        # 红蓝投票记录
│
└── utils
    ├── concurrency.js  # 并发控制工具（队列器+批处理限速器）
    ├── guildManager.js  # 服务器配置管理
    ├── helper.js         # 通用函数封装
    ├── logger.js         # 日志工具封装
    └── punishmentHelper.js  # 处罚系统工具函数
```

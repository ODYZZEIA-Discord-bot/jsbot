#!/bin/bash

# 设置工作目录
cd "$(dirname "$0")"

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# PM2配置文件
cat > ecosystem.config.cjs << EOL
module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'src/index.js',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    time: true,
    // 每7天（168小时）重启一次
    cron_restart: '0 0 */7 * *',
    // 优雅关闭
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 10000,
    node_args: '--experimental-modules'
  }]
}
EOL

# 创建日志目录
mkdir -p logs

# 检查PM2是否已经在运行这个应用
if pm2 list | grep -q "discord-bot"; then
    log "停止现有discord-bot进程..."
    pm2 stop discord-bot
    pm2 delete discord-bot
fi

# 启动应用
log "使用PM2启动Discord机器人..."
pm2 start ecosystem.config.cjs

# 保存PM2配置
log "保存PM2配置..."
pm2 save

# 设置开机自启
log "设置启动脚本..."
pm2 startup

log "机器人启动完成。使用 'pm2 logs discord-bot' 查看日志"

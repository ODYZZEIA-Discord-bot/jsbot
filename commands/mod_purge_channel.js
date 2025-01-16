const { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const { checkPermission, handlePermissionResult, measureTime, logTime, delay } = require('../utils/helper');
const { globalRequestQueue } = require('../utils/globalRequestQueue');

module.exports = {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('频道完全清理')
        .setDescription('清理指定消息之前的所有消息')
        .addStringOption(option =>
            option
                .setName('终点消息id')
                .setDescription('终点消息的ID（该消息及其之后的消息将被保留）')
                .setRequired(true)
                .setMinLength(17)
                .setMaxLength(20)),

    async execute(interaction, guildConfig) {
        // 检查权限
        const hasPermission = checkPermission(interaction.member, guildConfig.allowedRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        await interaction.deferReply({ flags: ['Ephemeral'] });
        const executionTimer = measureTime();

        try {
            const messageId = interaction.options.getString('终点消息id');
            
            // 验证消息ID格式
            if (!/^\d{17,20}$/.test(messageId)) {
                await interaction.editReply('❌ 无效的消息ID格式。请直接输入消息ID（17-20位数字）');
                return;
            }

            // 获取终点消息
            const channel = interaction.channel;
            const endMessage = await channel.messages.fetch(messageId)
                .catch(() => null);

            if (!endMessage) {
                await interaction.editReply('❌ 无法找到指定的消息。请确保消息ID正确且在当前频道中');
                return;
            }

            // 获取消息数量估算
            const messages = await channel.messages.fetch({ 
                limit: 100,
                before: endMessage.id 
            });
            
            // 创建确认按钮
            const confirmButton = new ButtonBuilder()
                .setCustomId('confirm_purge')
                .setLabel('确认清理')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder()
                .addComponents(confirmButton);

            // 发送确认消息
            const response = await interaction.editReply({
                embeds: [{
                    color: 0xff0000,
                    title: '⚠️ 清理确认',
                    description: [
                        `你确定要清理 ${channel.name} 中的历史消息吗？`,
                        '',
                        '**清理范围：**',
                        `- 终点消息：${endMessage.content.slice(0, 100)}...`,
                        `- 预计清理消息数：${messages.size}+`,
                        `- 清理时间范围：${endMessage.createdAt.toLocaleString()} 之前的消息`,
                        '',
                        '**⚠️ 警告：此操作不可撤销！**'
                    ].join('\n'),
                    footer: {
                        text: '此确认按钮将在5分钟后失效'
                    }
                }],
                components: [row]
            });

            try {
                const confirmation = await response.awaitMessageComponent({
                    filter: i => i.user.id === interaction.user.id,
                    time: 300000
                });

                if (confirmation.customId === 'confirm_purge') {
                    await confirmation.update({
                        content: '正在清理消息...',
                        embeds: [],
                        components: []
                    });

                    let deletedCount = 0;
                    let lastId = endMessage.id;
                    let batchSize = 100;
                    
                    while (true) {
                        // 获取消息批次
                        const messageBatch = await channel.messages.fetch({ 
                            limit: batchSize,
                            before: lastId 
                        });

                        if (messageBatch.size === 0) break;
                        
                        // 记录最后一条消息的ID
                        lastId = messageBatch.last().id;

                        // 过滤出14天内的消息用于批量删除
                        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
                        const recentMessages = messageBatch.filter(msg => msg.createdTimestamp > twoWeeksAgo);
                        const oldMessages = messageBatch.filter(msg => msg.createdTimestamp <= twoWeeksAgo);
                        logTime(`开始批量删除 ${recentMessages.size} 条新消息`);
                        logTime(`开始删除 ${oldMessages.size} 条旧消息`);

                        // 批量删除新消息
                        if (recentMessages.size > 0) {
                            await globalRequestQueue.add(async () => {
                                await channel.bulkDelete(recentMessages);
                            }, 1);
                        }

                        // 逐个删除旧消息
                        if (oldMessages.size > 0) {
                            // 每批5条消息
                            const batchSize = 5;
                            for (let i = 0; i < oldMessages.size; i += batchSize) {
                                const batch = Array.from(oldMessages.values()).slice(i, i + batchSize);
                                
                                // 每条等待200ms
                                for (const message of batch) {
                                    await message.delete()
                                        .catch(error => logTime(`删除旧消息失败: ${error.message}`, true));
                                    await delay(200);
                                }
                                
                                // 每批5条后等待1秒
                                await delay(1000);
                            }
                        }

                        deletedCount += messageBatch.size;

                        // 每删除500条消息更新一次状态
                        if (deletedCount % 500 === 0) {
                            await interaction.editReply({
                                content: `已清理 ${deletedCount} 条消息...`
                            });
                        }

                        // 添加短暂延迟避免触发限制
                        await delay(100);
                    }

                    const executionTime = executionTimer();
                    await interaction.editReply({
                        content: [
                            '✅ 清理完成！',
                            `📊 共清理 ${deletedCount} 条消息`,
                            `⏱️ 执行时间: ${executionTime}秒`
                        ].join('\n'),
                        embeds: [],
                        components: []
                    });

                    // 记录到日志频道
                    if (guildConfig.moderationThreadId) {
                        const logChannel = await interaction.client.channels.fetch(guildConfig.moderationThreadId);
                        await logChannel.send({
                            embeds: [{
                                color: 0x0099ff,
                                title: '频道清理日志',
                                fields: [
                                    {
                                        name: '操作人',
                                        value: `<@${interaction.user.id}>`,
                                        inline: true
                                    },
                                    {
                                        name: '清理频道',
                                        value: `<#${channel.id}>`,
                                        inline: true
                                    },
                                    {
                                        name: '清理范围',
                                        value: `${endMessage.createdAt.toLocaleString()} 之前的消息`,
                                        inline: false
                                    },
                                    {
                                        name: '清理数量',
                                        value: `${deletedCount} 条消息`,
                                        inline: true
                                    },
                                    {
                                        name: '执行时间',
                                        value: `${executionTime}秒`,
                                        inline: true
                                    }
                                ],
                                timestamp: new Date()
                            }]
                        });
                    }
                }
            } catch (error) {
                if (error.code === 'InteractionCollectorError') {
                    await interaction.editReply({
                        content: '❌ 确认已超时，清理操作已取消。',
                        embeds: [],
                        components: []
                    });
                } else {
                    throw error;
                }
            }

        } catch (error) {
            console.error('清理执行错误:', error);
            await interaction.editReply({
                content: `执行清理时出现错误: ${error.message}`,
                embeds: [],
                components: []
            });
        }
    },
}; 
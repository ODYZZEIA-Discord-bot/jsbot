const { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const { checkPermission, handlePermissionResult, measureTime, logTime } = require('../utils/helper');

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
                        // 并行获取多个批次的消息
                        const messageBatch = await channel.messages.fetch({ 
                            limit: batchSize,
                            before: lastId 
                        });

                        if (messageBatch.size === 0) break;
                        
                        // 记录最后一条消息的ID用于下次查询
                        lastId = messageBatch.last().id;

                        // 批量删除消息
                        await channel.bulkDelete(messageBatch, true)
                            .catch(async error => {
                                // 如果批量删除失败，尝试逐条删除
                                const deletePromises = messageBatch.map(msg => 
                                    msg.delete().catch(() => null)
                                );
                                await Promise.all(deletePromises);
                            });

                        deletedCount += messageBatch.size;

                        // 每删除500条消息更新一次状态
                        if (deletedCount % 500 === 0) {
                            await interaction.editReply({
                                content: `已清理 ${deletedCount} 条消息...`
                            });
                        }

                        // 添加短暂延迟避免触发限制
                        await new Promise(resolve => setTimeout(resolve, 100));
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
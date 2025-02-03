import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { ProcessModel } from '../db/models/processModel.js';
import { handleConfirmationButton } from '../handlers/buttons.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { handleCommandError, validateImageUrl } from '../utils/helper.js';
import { calculatePunishmentDuration, formatPunishmentDuration } from '../utils/punishmentHelper.js';

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('申请上庭')
        .setDescription('向议事区提交处罚申请')
        .addSubcommand(subcommand =>
            subcommand
                .setName('禁言')
                .setDescription('申请禁言处罚')
                .addUserOption(option => option.setName('目标').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option =>
                    option.setName('禁言时间').setDescription('禁言时长 (例如: 3d5h，即3天5小时)').setRequired(true),
                )
                .addStringOption(option =>
                    option
                        .setName('理由')
                        .setDescription('处罚理由（至多1000字，可以带有消息链接等）')
                        .setRequired(true),
                )
                .addRoleOption(option =>
                    option
                        .setName('撤销身份组')
                        .setDescription('要撤销的身份组（该用户必须有此身份组）')
                        .setRequired(false),
                )
                .addStringOption(option =>
                    option.setName('附加警告期').setDescription('附加警告时长 (例如: 30d，即30天)').setRequired(false),
                )
                .addStringOption(option =>
                    option
                        .setName('图片链接')
                        .setDescription('相关证据的图片链接 (可来自图床/DiscordCDN)')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('永封')
                .setDescription('申请永久封禁')
                .addUserOption(option => option.setName('目标').setDescription('要处罚的用户').setRequired(true))
                .addStringOption(option => option.setName('理由').setDescription('处罚理由').setRequired(true))
                .addBooleanOption(option =>
                    option.setName('保留消息').setDescription('是否保留用户的消息').setRequired(false),
                )
                .addStringOption(option =>
                    option
                        .setName('图片链接')
                        .setDescription('相关证据的图片链接 (可来自图床/DiscordCDN)')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('撤销')
                .setDescription('撤销处罚申请')
                .addStringOption(option =>
                    option.setName('消息链接').setDescription('要撤销的议事区议事消息的链接').setRequired(true),
                ),
        ),

    async execute(interaction, guildConfig) {
        // 检查议事系统是否启用
        if (!guildConfig.courtSystem?.enabled) {
            await interaction.editReply({
                content: '❌ 此服务器未启用议事系统',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查议员权限
        if (!interaction.member.roles.cache.has(guildConfig.courtSystem.senatorRoleId)) {
            await interaction.editReply({
                content: '❌ 只有议员可以使用此命令',
                flags: ['Ephemeral'],
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === '禁言' || subcommand === '永封') {
                const target = interaction.options.getUser('目标');
                const reason = interaction.options.getString('理由');
                const imageUrl = interaction.options.getString('图片链接');

                // 检查目标用户是否为管理员
                const member = await interaction.guild.members.fetch(target.id);
                if (member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await interaction.editReply({
                        content: '❌ 无法对管理员执行处罚',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 在获取图片链接后立即验证
                if (imageUrl) {
                    const { isValid, error } = validateImageUrl(imageUrl);
                    if (!isValid) {
                        await interaction.editReply({
                            content: `❌ ${error}`,
                            flags: ['Ephemeral'],
                        });
                        return;
                    }
                }

                if (subcommand === '禁言') {
                    const muteTime = interaction.options.getString('禁言时间');
                    const warningTime = interaction.options.getString('附加警告期');
                    const revokeRole = interaction.options.getRole('撤销身份组');

                    // 验证时间格式
                    const muteDuration = calculatePunishmentDuration(muteTime);
                    if (muteDuration === -1) {
                        await interaction.editReply({
                            content: '❌ 无效的禁言时长格式',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 检查撤销身份组
                    if (revokeRole) {
                        if (!member.roles.cache.has(revokeRole.id)) {
                            await interaction.editReply({
                                content: `❌ 目标用户 ${target.tag} 并没有 ${revokeRole.name} 身份组`,
                                flags: ['Ephemeral'],
                            });
                            return;
                        }
                    }

                    let warningDuration = null;
                    if (warningTime) {
                        warningDuration = calculatePunishmentDuration(warningTime);
                        if (warningDuration === -1) {
                            await interaction.editReply({
                                content: '❌ 无效的警告时长格式',
                                flags: ['Ephemeral'],
                            });
                            return;
                        }
                    }

                    // 创建确认消息
                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_court_mute',
                        buttonLabel: '确认提交',
                        embed: {
                            color: 0xff9900,
                            title: revokeRole ? '禁言处罚及身份组撤销申请' : '禁言处罚申请',
                            description: [
                                `你确定要向议事区提交对 ${target.tag} 的处罚申请吗？`,
                                '',
                                '**处罚详情：**',
                                '- 类型：禁言',
                                `- 目标：${target.tag} (${target.id})`,
                                `- 时长：${formatPunishmentDuration(muteDuration)}`,
                                warningTime ? `- 附加警告期：${formatPunishmentDuration(warningDuration)}` : null,
                                revokeRole ? `- 撤销身份组：${revokeRole.name}` : null,
                                `- 理由：${reason}`,
                                '',
                                '请慎重考虑占用公共资源。如需撤销请使用 撤销 子命令。',
                            ]
                                .filter(Boolean)
                                .join('\n'),
                            image: imageUrl ? { url: imageUrl } : undefined,
                        },
                        onConfirm: async confirmation => {
                            // 更新交互消息
                            await confirmation.deferUpdate();

                            // 获取议事区频道
                            const courtChannel = await interaction.guild.channels.fetch(
                                guildConfig.courtSystem.courtChannelId,
                            );

                            // 计算过期时间
                            const expireTime = new Date(Date.now() + guildConfig.courtSystem.appealDuration);

                            // 发送议事申请消息
                            const message = await courtChannel.send({
                                embeds: [
                                    {
                                        color: 0xff9900,
                                        title: revokeRole ? '禁言处罚及身份组撤销申请' : '禁言处罚申请',
                                        description: `议事截止：<t:${Math.floor(expireTime.getTime() / 1000)}:R>`,
                                        fields: [
                                            {
                                                name: '处罚对象',
                                                value: `<@${target.id}>`,
                                                inline: true,
                                            },
                                            {
                                                name: '禁言时长',
                                                value: formatPunishmentDuration(muteDuration),
                                                inline: true,
                                            },
                                            warningTime
                                                ? {
                                                      name: '附加警告期',
                                                      value: formatPunishmentDuration(warningDuration),
                                                      inline: true,
                                                  }
                                                : null,
                                            revokeRole
                                                ? {
                                                      name: '撤销身份组',
                                                      value: revokeRole.name,
                                                      inline: true,
                                                  }
                                                : null,
                                            {
                                                name: '处罚理由',
                                                value: reason,
                                                inline: false,
                                            },
                                        ].filter(Boolean),
                                        timestamp: new Date(),
                                        footer: {
                                            text: `申请人：${interaction.user.tag}`,
                                        },
                                        image: imageUrl ? { url: imageUrl } : undefined,
                                    },
                                ],
                                components: [
                                    {
                                        type: 1,
                                        components: [
                                            {
                                                type: 2,
                                                style: 3,
                                                label: '支持',
                                                custom_id: `support_mute_${target.id}_${interaction.user.id}`,
                                                emoji: '👍',
                                            },
                                        ],
                                    },
                                ],
                            });

                            // 创建新的议事流程
                            const process = await ProcessModel.createCourtProcess({
                                type: 'court_mute',
                                targetId: target.id,
                                executorId: interaction.user.id,
                                messageId: message.id,
                                expireAt: expireTime.getTime(),
                                details: {
                                    embed: message.embeds[0].toJSON(),
                                    muteTime,
                                    warningTime,
                                    revokeRoleId: revokeRole?.id,
                                },
                            });

                            // 调度流程到期处理
                            if (process) {
                                await globalTaskScheduler
                                    .getProcessScheduler()
                                    .scheduleProcess(process, interaction.client);
                            }

                            // 发送通知到当前频道
                            await interaction.channel.send({
                                embeds: [
                                    {
                                        color: 0x00ff00,
                                        title: '议事申请已创建',
                                        description: [
                                            `<@${interaction.user.id}> 已创建对 <@${target.id}> 的禁言处罚申请`,
                                            '',
                                            '**申请详情：**',
                                            `- 禁言时长：${formatPunishmentDuration(muteDuration)}`,
                                            warningTime
                                                ? `- 附加警告期：${formatPunishmentDuration(warningDuration)}`
                                                : null,
                                            revokeRole ? `- 撤销身份组：${revokeRole.name}` : null,
                                            `- 处罚理由：${reason}`,
                                            '',
                                            `👉 [点击查看议事区](${courtChannel.url})`,
                                        ]
                                            .filter(Boolean)
                                            .join('\n'),
                                        timestamp: new Date(),
                                    },
                                ],
                            });

                            await interaction.editReply({
                                content: '✅ 处罚申请已提交到议事区',
                                components: [],
                                embeds: [],
                                flags: ['Ephemeral'],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '申请上庭');
                        },
                    });
                } else if (subcommand === '永封') {
                    const keepMessages = interaction.options.getBoolean('保留消息') ?? true;
                    const imageUrl = interaction.options.getString('图片链接');

                    // 检查目标用户是否为管理员
                    const member = await interaction.guild.members.fetch(target.id);
                    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
                        await interaction.editReply({
                            content: '❌ 无法对管理员执行处罚',
                            flags: ['Ephemeral'],
                        });
                        return;
                    }

                    // 在获取图片链接后立即验证
                    if (imageUrl) {
                        const { isValid, error } = validateImageUrl(imageUrl);
                        if (!isValid) {
                            await interaction.editReply({
                                content: `❌ ${error}`,
                                flags: ['Ephemeral'],
                            });
                            return;
                        }
                    }

                    await handleConfirmationButton({
                        interaction,
                        customId: 'confirm_court_ban',
                        buttonLabel: '确认提交',
                        embed: {
                            color: 0xff0000,
                            title: '⚖️ 议事区申请确认',
                            description: [
                                `你确定要向议事区提交对 ${target.tag} 的永封申请吗？`,
                                '',
                                '**处罚详情：**',
                                '- 类型：永久封禁',
                                `- 目标：${target.tag} (${target.id})`,
                                `- ${keepMessages ? '保留' : '删除'}用户消息`,
                                `- 理由：${reason}`,
                                '',
                                '请慎重考虑占用公共资源。如需撤销请使用 撤销 子命令。',
                            ].join('\n'),
                            image: imageUrl ? { url: imageUrl } : undefined,
                        },
                        onConfirm: async confirmation => {
                            // 更新交互消息
                            await confirmation.deferUpdate();

                            // 获取议事区频道
                            const courtChannel = await interaction.guild.channels.fetch(
                                guildConfig.courtSystem.courtChannelId,
                            );

                            // 计算过期时间
                            const expireTime = new Date(Date.now() + guildConfig.courtSystem.appealDuration);

                            // 发送议事申请消息
                            const message = await courtChannel.send({
                                embeds: [
                                    {
                                        color: 0xff0000,
                                        title: '永封处罚申请',
                                        description: `议事截止：<t:${Math.floor(expireTime.getTime() / 1000)}:R>`,
                                        fields: [
                                            {
                                                name: '处罚对象',
                                                value: `<@${target.id}>`,
                                                inline: true,
                                            },
                                            {
                                                name: '消息处理',
                                                value: keepMessages ? '保留消息' : '删除消息',
                                                inline: true,
                                            },
                                            {
                                                name: '处罚理由',
                                                value: reason,
                                                inline: false,
                                            },
                                        ],
                                        timestamp: new Date(),
                                        footer: {
                                            text: `申请人：${interaction.user.tag}`,
                                        },
                                        image: imageUrl ? { url: imageUrl } : undefined,
                                    },
                                ],
                                components: [
                                    {
                                        type: 1,
                                        components: [
                                            {
                                                type: 2,
                                                style: 3,
                                                label: '支持',
                                                custom_id: `support_ban_${target.id}_${interaction.user.id}`,
                                                emoji: '👍',
                                            },
                                        ],
                                    },
                                ],
                            });

                            // 创建新的议事流程
                            const process = await ProcessModel.createCourtProcess({
                                type: 'court_ban',
                                targetId: target.id,
                                executorId: interaction.user.id,
                                messageId: message.id,
                                expireAt: expireTime.getTime(),
                                details: {
                                    embed: message.embeds[0].toJSON(),
                                    keepMessages,
                                },
                            });

                            // 调度流程到期处理
                            if (process) {
                                await globalTaskScheduler
                                    .getProcessScheduler()
                                    .scheduleProcess(process, interaction.client);
                            }

                            // 发送通知到当前频道
                            await interaction.channel.send({
                                embeds: [
                                    {
                                        color: 0x00ff00,
                                        title: '议事申请已创建',
                                        description: [
                                            `<@${interaction.user.id}> 已创建对 <@${target.id}> 的永封处罚申请`,
                                            '',
                                            '**申请详情：**',
                                            `- 消息处理：${keepMessages ? '保留' : '删除'}用户消息`,
                                            `- 处罚理由：${reason}`,
                                            '',
                                            `👉 [点击查看议事区](${courtChannel.url})`,
                                        ].join('\n'),
                                        timestamp: new Date(),
                                    },
                                ],
                            });

                            await interaction.editReply({
                                content: '✅ 处罚申请已提交到议事区',
                                components: [],
                                embeds: [],
                                flags: ['Ephemeral'],
                            });
                        },
                        onError: async error => {
                            await handleCommandError(interaction, error, '申请上庭');
                        },
                    });
                }
            } else if (subcommand === '撤销') {
                const messageUrl = interaction.options.getString('消息链接');

                // 从链接中提取消息ID
                const messageId = messageUrl.split('/').pop();
                if (!messageId) {
                    await interaction.editReply({
                        content: '❌ 无效的消息链接',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 获取流程记录
                const process = await ProcessModel.getProcessByMessageId(messageId);
                if (!process) {
                    await interaction.editReply({
                        content: '❌ 找不到相关的议事流程',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 验证申请人身份
                if (process.executorId !== interaction.user.id) {
                    await interaction.editReply({
                        content: '❌ 只有原申请人可以撤销申请',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 验证流程状态
                if (!['pending', 'in_progress'].includes(process.status)) {
                    await interaction.editReply({
                        content: '❌ 此申请已无法撤销',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                try {
                    // 删除原消息
                    const channel = await interaction.guild.channels.fetch(guildConfig.courtSystem.courtChannelId);
                    const message = await channel.messages.fetch(messageId);
                    await message.delete();

                    // 更新流程状态
                    await ProcessModel.updateStatus(process.id, 'cancelled', {
                        reason: '申请人撤销',
                    });

                    // 清除定时器
                    await globalTaskScheduler.getProcessScheduler().cancelProcess(process.id);

                    // 通知双方
                    const [executor, target] = await Promise.all([
                        interaction.client.users.fetch(process.executorId).catch(() => null),
                        interaction.client.users.fetch(process.targetId).catch(() => null),
                    ]);

                    const notifyContent = '✅ 关于您的上庭申请已被申请者撤销';
                    if (executor) await executor.send({ content: notifyContent, flags: ['Ephemeral'] });
                    if (target) await target.send({ content: notifyContent, flags: ['Ephemeral'] });

                    await interaction.editReply({
                        content: '✅ 已撤销申请',
                        flags: ['Ephemeral'],
                    });
                } catch (error) {
                    await handleCommandError(interaction, error, '撤销申请');
                }
            }
        } catch (error) {
            await handleCommandError(interaction, error, '申请上庭');
        }
    },
};

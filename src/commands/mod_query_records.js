import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { VoteModel } from '../db/models/voteModel.js';
import { checkModeratorPermission, handleCommandError } from '../utils/helper.js';
import { formatPunishmentDuration } from '../utils/punishmentHelper.js';

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('查询记录')
        .setDescription('查询数据库记录')
        .addStringOption(option =>
            option
                .setName('类型')
                .setDescription('要查询的记录类型')
                .setRequired(true)
                .addChoices(
                    { name: '处罚记录', value: 'punishment' },
                    { name: '流程记录', value: 'process' },
                    { name: '投票记录', value: 'vote' }
                ),
        )
        .addUserOption(option => option.setName('用户').setDescription('筛选特定用户（可选）').setRequired(false)),

    async execute(interaction, guildConfig) {
        try {
            // 需要版主或管理员权限
            if (!(await checkModeratorPermission(interaction, guildConfig))) {
                return;
            }

            const type = interaction.options.getString('类型');
            const targetUser = interaction.options.getUser('用户');

            if (type === 'punishment') {
                // 查询处罚记录：全库只查活跃，个人查所有历史
                const punishments = targetUser
                    ? await PunishmentModel.getUserPunishments(targetUser.id, true) // 包含历史记录
                    : await PunishmentModel.getAllPunishments(false); // 只显示活跃记录

                if (!punishments || punishments.length === 0) {
                    await interaction.editReply({
                        content: targetUser
                            ? `✅ 用户 ${targetUser.tag} 没有任何处罚记录`
                            : '✅ 数据库中没有活跃的处罚记录',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 分页处理（每页10条记录）
                const pages = [];
                const pageSize = 10;
                for (let i = 0; i < punishments.length; i += pageSize) {
                    const pageRecords = punishments.slice(i, i + pageSize);
                    const fields = await Promise.all(
                        pageRecords.map(async (p, index) => {
                            const executor = await interaction.client.users.fetch(p.executorId).catch(() => null);

                            const typeText = {
                                ban: '永封',
                                mute: '禁言',
                            };

                            const statusText = {
                                active: '🟢 生效中',
                                expired: '⚪ 已到期',
                                appealed: '🔵 已上诉',
                                revoked: '🔴 已撤销',
                            };

                            // 格式化处罚信息
                            const punishmentInfo = [
                                `**执行人:** ${executor ? `<@${executor.id}>` : '未知'}`,
                                !targetUser ? `**处罚对象:** <@${p.targetId}>` : null,
                                `**原因:** ${p.reason}`,
                                `**时长:** ${formatPunishmentDuration(p.duration)}`,
                                p.warningDuration ? `**警告剩余时间:** <t:${Math.floor((p.createdAt + p.warningDuration) / 1000)}:R>` : null,
                                p.status === 'active'
                                    ? `**到期时间:** ${
                                          p.duration === -1
                                              ? '永久'
                                              : `<t:${Math.floor((p.createdAt + p.duration) / 1000)}:R>`
                                      }`
                                    : `**禁言剩余时间:** <t:${Math.floor(p.updatedAt / 1000)}:R>`,
                                p.status === 'revoked' ? `**撤销原因:** ${p.revokeReason || '无'}` : null,
                                `**处罚ID:** ${p.id}`,
                            ]
                                .filter(Boolean)
                                .join('\n');

                            return {
                                name: `${statusText[p.status]} ${typeText[p.type]} (#${i + index + 1})`,
                                value: punishmentInfo,
                                inline: false,
                            };
                        }),
                    );

                    pages.push({
                        embeds: [
                            {
                                color: targetUser ? 0x3498db : 0x0099ff, // 用户查询使用不同颜色
                                title: '处罚记录查询结果',
                                description: targetUser
                                    ? `用户 <@${targetUser.id}> 的处罚历史记录`
                                    : '当前活跃的处罚记录',
                                fields,
                                timestamp: new Date(),
                                footer: {
                                    text: `第 ${pages.length + 1} 页 | 共 ${Math.ceil(
                                        punishments.length / pageSize,
                                    )} 页 | 总计 ${punishments.length} 条记录`,
                                },
                            },
                        ],
                    });
                }

                // 发送第一页
                const addPaginationButtons = page => {
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('page_prev').setLabel('上一页').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('page_next').setLabel('下一页').setStyle(ButtonStyle.Primary),
                    );
                    return { ...page, components: [row] };
                };

                const message = await interaction.editReply(addPaginationButtons(pages[0]));

                // 缓存页面数据（5分钟后自动清除）
                interaction.client.pageCache = interaction.client.pageCache || new Map();
                interaction.client.pageCache.set(message.id, pages);
                setTimeout(() => interaction.client.pageCache.delete(message.id), 5 * 60 * 1000);
            } else if (type === 'process') {
                // 查询流程记录
                const processes = targetUser
                    ? await ProcessModel.getUserProcesses(targetUser.id, true) // 包含历史记录
                    : await ProcessModel.getAllProcesses(false); // 只显示进行中和待处理的记录

                if (!processes || processes.length === 0) {
                    await interaction.editReply({
                        content: targetUser ? `✅ 用户 ${targetUser.tag} 没有相关流程记录` : '✅ 数据库中没有流程记录',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 获取主服务器配置
                const mainGuildConfig = Array.from(interaction.client.guildManager.guilds.values())
                    .find(config => config.serverType === 'Main server' && config.courtSystem?.enabled);

                // 构建消息链接基础URL（如果可用）
                const courtChannelId = mainGuildConfig?.courtSystem?.courtChannelId;
                const mainGuildId = mainGuildConfig?.id;
                const baseMessageUrl = courtChannelId && mainGuildId
                    ? `https://discord.com/channels/${mainGuildId}/${courtChannelId}/`
                    : '';

                // 分页处理（每页10条记录）
                const pages = [];
                const pageSize = 10;
                for (let i = 0; i < processes.length; i += pageSize) {
                    const pageRecords = processes.slice(i, i + pageSize);
                    const fields = await Promise.all(
                        pageRecords.map(async (p, index) => {
                            const typeText = {
                                appeal: '处罚上诉',
                                vote: '投票',
                                debate: '议案议事',
                                court_mute: '禁言申请',
                                court_ban: '永封申请',
                            };

                            const statusText = {
                                pending: '⚪ 待处理',
                                in_progress: '🟡 进行中',
                                completed: '🟢 已完成',
                                rejected: '🔴 已拒绝',
                                cancelled: '⚫ 已取消',
                            };

                            // 获取执行人和目标用户信息
                            const [executor, target] = await Promise.all([
                                interaction.client.users.fetch(p.executorId).catch(() => null),
                                interaction.client.users.fetch(p.targetId).catch(() => null),
                            ]);

                            // 使用预先构建的baseMessageUrl
                            const messageLink = p.messageId && baseMessageUrl ? `${baseMessageUrl}${p.messageId}` : '';

                            return {
                                name: `${statusText[p.status]} ${typeText[p.type]} (#${i + index + 1})`,
                                value: [
                                    `**执行人:** ${executor ? `<@${executor.id}>` : '未知'}`,
                                    `**目标用户:** ${target ? `<@${target.id}>` : '未知'}`,
                                    `**状态:** ${statusText[p.status]}`,
                                    p.status === 'completed'
                                        ? `**结果:** ${p.result || '无'}\n**原因:** ${p.reason || '无'}`
                                        : `**到期时间:** <t:${Math.floor(p.expireAt / 1000)}:R>`,
                                    p.debateThreadId ? `**辩诉帖:** <#${p.debateThreadId}>` : null,
                                    messageLink ? `**议事消息:** [点击查看](${messageLink})` : null,
                                    `**流程ID:** ${p.id}`,
                                ]
                                    .filter(Boolean)
                                    .join('\n'),
                                inline: false,
                            };
                        }),
                    );

                    pages.push({
                        embeds: [
                            {
                                color: 0x0099ff,
                                title: '流程记录查询结果',
                                description: targetUser
                                    ? `用户 ${targetUser.tag} (${targetUser.id}) 的流程记录`
                                    : '全库流程记录',
                                fields,
                                timestamp: new Date(),
                                footer: {
                                    text: `第 ${pages.length + 1} 页 | 共 ${Math.ceil(
                                        processes.length / pageSize,
                                    )} 页 | 总计 ${processes.length} 条记录`,
                                },
                            },
                        ],
                    });
                }

                // 发送第一页
                const addPaginationButtons = page => {
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('page_prev').setLabel('上一页').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('page_next').setLabel('下一页').setStyle(ButtonStyle.Primary),
                    );
                    return { ...page, components: [row] };
                };

                const message = await interaction.editReply(addPaginationButtons(pages[0]));

                // 缓存页面数据（5分钟后自动清除）
                interaction.client.pageCache = interaction.client.pageCache || new Map();
                interaction.client.pageCache.set(message.id, pages);
                setTimeout(() => interaction.client.pageCache.delete(message.id), 5 * 60 * 1000);
            } else if (type === 'vote') {
                // 查询投票记录
                const votes = targetUser
                    ? await VoteModel.getUserVotes(targetUser.id, true) // 包含历史记录
                    : await VoteModel.getAllVotes(false); // 全部记录

                if (!votes || votes.length === 0) {
                    await interaction.editReply({
                        content: targetUser
                            ? `✅ 用户 ${targetUser.tag} 没有参与任何投票记录`
                            : '✅ 数据库中没有投票记录',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                // 获取主服务器配置
                const mainGuildConfig = Array.from(interaction.client.guildManager.guilds.values())
                    .find(config => config.serverType === 'Main server' && config.courtSystem?.enabled);

                // 构建消息链接和辩诉帖链接的基础URL
                const debateChannelId = mainGuildConfig?.courtSystem?.debateChannelId;
                const mainGuildId = mainGuildConfig?.id;

                // 分页处理（每页10条记录）
                const pages = [];
                const pageSize = 10;
                for (let i = 0; i < votes.length; i += pageSize) {
                    const pageRecords = votes.slice(i, i + pageSize);
                    const fields = await Promise.all(
                        pageRecords.map(async (v, index) => {
                            // 投票类型
                            const typeText = {
                                appeal: '处罚上诉',
                                court_mute: '禁言申请',
                                court_ban: '永封申请',
                            };

                            // 投票状态
                            const statusText = {
                                in_progress: '🟡 进行中',
                                completed: '🟢 已完成',
                            };

                            // 投票结果
                            const resultText = {
                                red_win: '🔴 红方胜利',
                                blue_win: '🔵 蓝方胜利',
                                cancelled: '⚫ 已取消',
                            };

                            // 获取详情中的执行者和目标用户
                            let executor = null;
                            let target = null;

                            if (v.details && v.details.executorId) {
                                executor = await interaction.client.users.fetch(v.details.executorId).catch(() => null);
                            }

                            if (v.details && v.details.targetId) {
                                target = await interaction.client.users.fetch(v.details.targetId).catch(() => null);
                            }

                            // 构建消息链接
                            let messageLink = '';
                            if (v.messageId && mainGuildId && debateChannelId) {
                                messageLink = `https://discord.com/channels/${mainGuildId}/${v.threadId}/${v.messageId}`;
                            }

                            // 辩诉帖链接
                            let threadLink = '';
                            if (v.threadId && debateChannelId && mainGuildId) {
                                threadLink = `https://discord.com/channels/${mainGuildId}/${debateChannelId}/${v.threadId}`;
                            }

                            // 确定投票类型显示文本
                            const displayType = typeText[v.type] || '投票';

                            // 基本信息
                            const voteInfo = [
                                `**红方诉求:** ${v.redSide}`,
                                `**蓝方诉求:** ${v.blueSide}`,
                                executor ? `**发起人:** <@${v.details.executorId}>` : null,
                                target ? `**目标用户:** <@${v.details.targetId}>` : null,
                                `**状态:** ${statusText[v.status] || v.status}`,
                                v.status === 'completed' ? `**结果:** ${resultText[v.result] || '无结果'}` : null,
                                `**红方票数:** ${v.redVoters.length}`,
                                `**蓝方票数:** ${v.blueVoters.length}`,
                                `**开始时间:** <t:${Math.floor(v.startTime / 1000)}:R>`,
                                v.status === 'in_progress'
                                    ? `**结束时间:** <t:${Math.floor(v.endTime / 1000)}:R>`
                                    : `**完成于:** <t:${Math.floor(v.updatedAt / 1000)}:R>`,
                                v.threadId ? `**辩诉帖:** <#${v.threadId}>` : null,
                                messageLink ? `**投票消息:** [点击查看](${messageLink})` : null,
                                `**投票ID:** ${v.id}`,
                                v.processId ? `**关联流程ID:** ${v.processId}` : null,
                            ].filter(Boolean).join('\n');

                            return {
                                name: `${statusText[v.status] || v.status} ${displayType} (#${i + index + 1})`,
                                value: voteInfo,
                                inline: false,
                            };
                        }),
                    );

                    pages.push({
                        embeds: [
                            {
                                color: 0x5865f2, // Discord蓝
                                title: '投票记录查询结果',
                                description: targetUser
                                    ? `用户 ${targetUser.tag} 参与的投票记录`
                                    : '全库投票记录',
                                fields,
                                timestamp: new Date(),
                                footer: {
                                    text: `第 ${pages.length + 1} 页 | 共 ${Math.ceil(
                                        votes.length / pageSize,
                                    )} 页 | 总计 ${votes.length} 条记录`,
                                },
                            },
                        ],
                    });
                }

                // 发送第一页
                const addPaginationButtons = page => {
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('page_prev').setLabel('上一页').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('page_next').setLabel('下一页').setStyle(ButtonStyle.Primary),
                    );
                    return { ...page, components: [row] };
                };

                const message = await interaction.editReply(addPaginationButtons(pages[0]));

                // 缓存页面数据（5分钟后自动清除）
                interaction.client.pageCache = interaction.client.pageCache || new Map();
                interaction.client.pageCache.set(message.id, pages);
                setTimeout(() => interaction.client.pageCache.delete(message.id), 5 * 60 * 1000);
            }
        } catch (error) {
            await handleCommandError(interaction, error, '查询记录');
        }
    },
};

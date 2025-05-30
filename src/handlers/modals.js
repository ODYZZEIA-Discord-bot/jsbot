import { ChannelType } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { manageRolesByGroups } from '../services/roleApplication.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { formatPunishmentDuration } from '../utils/punishmentHelper.js';
import { globalTaskScheduler } from './scheduler.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

/**
 * 统一处理投稿提交
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 * @param {string} type - 投稿类型（news或opinion）
 * @param {string} titlePrefix - 标题前缀
 * @param {number} color - 嵌入消息颜色
 */
const handleSubmission = async (interaction, type, titlePrefix, color) => {
    try {
        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig?.opinionMailThreadId) {
            await interaction.editReply({
                content: '❌ 此服务器未配置意见信箱频道',
            });
            return;
        }

        // 获取用户输入
        const title = interaction.fields.getTextInputValue(`${type}_title`);
        const content = interaction.fields.getTextInputValue(`${type}_content`);

        // 创建嵌入消息
        const messageEmbed = {
            color: color,
            title: `${titlePrefix}${title}`,
            description: content,
            author: {
                name: interaction.user.tag,
                icon_url: interaction.user.displayAvatarURL(),
            },
            timestamp: new Date(),
            footer: {
                text: '等待管理员审定'
            }
        };

        // 创建判定按钮
        const buttons = [
            {
                type: 2,
                style: 3, // Success (绿色)
                label: '合理',
                custom_id: `approve_submission_${interaction.user.id}_${type}`,
                emoji: { name: '✅' }
            },
            {
                type: 2,
                style: 4, // Danger (红色)
                label: '不合理',
                custom_id: `reject_submission_${interaction.user.id}_${type}`,
                emoji: { name: '🚪' }
            }
        ];

        const actionRow = {
            type: 1,
            components: buttons
        };

        // 获取目标频道并发送消息
        try {
            const targetChannel = await interaction.client.channels.fetch(guildConfig.opinionMailThreadId);
            if (!targetChannel) {
                throw new Error('无法获取目标频道');
            }

            await targetChannel.send({
                embeds: [messageEmbed],
                components: [actionRow]
            });

            // 回复用户确认消息
            await interaction.editReply({
                content: `✅ ${type === 'news' ? '新闻投稿' : '社区意见'}已成功提交！`,
            });

            logTime(`用户 ${interaction.user.tag} 提交了${type === 'news' ? '新闻投稿' : '社区意见'}: "${title}"`);
        } catch (error) {
            throw new Error(`发送投稿时出错: ${error.message}`);
        }
    } catch (error) {
        logTime(`处理${type === 'news' ? '新闻投稿' : '社区意见'}失败: ${error.message}`, true);
        await interaction.editReply({
            content: `❌ 提交${type === 'news' ? '新闻' : '意见'}时出错，请稍后重试`,
        });
    }
};

/**
 * 模态框处理器映射
 * 每个处理器函数接收一个 ModalSubmitInteraction 参数
 */
export const modalHandlers = {
    // 身份组申请模态框处理器
    creator_role_modal: async interaction => {
        try {
            const threadLink = interaction.fields.getTextInputValue('thread_link');
            const matches = threadLink.match(/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/);

            if (!matches) {
                await interaction.editReply('❌ 无效的帖子链接格式');
                return;
            }

            const [, linkGuildId, threadId] = matches;
            const currentGuildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

            if (!currentGuildConfig?.roleApplication?.creatorRoleId) {
                await interaction.editReply('❌ 服务器配置错误');
                return;
            }

            // 检查链接所属服务器是否在配置中
            const linkGuildConfig = interaction.client.guildManager.getGuildConfig(linkGuildId);
            if (!linkGuildConfig) {
                await interaction.editReply('❌ 提供的帖子不在允许的服务器中');
                return;
            }

            await globalRequestQueue.add(async () => {
                const thread = await interaction.client.channels.fetch(threadId);

                if (!thread || !thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
                    await interaction.editReply('❌ 提供的链接不是论坛帖子');
                    return;
                }

                // 获取首条消息
                const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
                const threadStarter = firstMessage.first();

                if (!threadStarter || threadStarter.author.id !== interaction.user.id) {
                    await interaction.editReply('❌ 您不是该帖子的作者');
                    return;
                }

                // 获取反应数最多的表情
                let maxReactions = 0;
                threadStarter.reactions.cache.forEach(reaction => {
                    const count = reaction.count;
                    if (count > maxReactions) {
                        maxReactions = count;
                    }
                });

                // 准备审核日志
                const moderationChannel = await interaction.client.channels.fetch(
                    currentGuildConfig.roleApplication.logThreadId,
                );
                const auditEmbed = {
                    color: maxReactions >= 5 ? 0x00ff00 : 0xff0000,
                    title: maxReactions >= 5 ? '✅ 创作者身份组申请通过' : '❌ 创作者身份组申请未通过',
                    fields: [
                        {
                            name: '申请者',
                            value: `<@${interaction.user.id}>`,
                            inline: true,
                        },
                        {
                            name: '作品链接',
                            value: threadLink,
                            inline: true,
                        },
                        {
                            name: '最高反应数',
                            value: `${maxReactions}`,
                            inline: true,
                        },
                        {
                            name: '作品所在服务器',
                            value: thread.guild.name,
                            inline: true,
                        },
                    ],
                    timestamp: new Date(),
                    footer: {
                        text: '自动审核系统',
                    },
                };

                if (maxReactions >= 5) {
                    try {
                        // 读取身份组同步配置
                        const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
                        const creatorSyncGroup = roleSyncConfig.syncGroups.find(group => group.name === '创作者');

                        if (creatorSyncGroup) {
                            // 使用manageRolesByGroups函数批量添加身份组
                            const result = await manageRolesByGroups(
                                interaction.client,
                                interaction.user.id,
                                [creatorSyncGroup],
                                '创作者身份组申请通过',
                                false // 设置为添加操作
                            );

                            // 只向用户显示成功的结果
                            if (result.successfulServers.length > 0) {
                                await interaction.editReply(
                                    `✅ 审核通过！已为您添加创作者身份组${
                                        result.successfulServers.length > 1
                                            ? `（已同步至：${result.successfulServers.join('、')}）`
                                            : ''
                                    }`,
                                );
                            } else {
                                await interaction.editReply('❌ 添加身份组时出现错误，请联系管理员。');
                            }

                            // 发送审核日志
                            if (moderationChannel) {
                                await moderationChannel.send({ embeds: [auditEmbed] });
                            }
                            // 记录完整日志到后台
                            logTime(
                                `[自动审核] 用户 ${
                                    interaction.user.tag
                                } 获得了创作者身份组, 同步至: ${result.successfulServers.join('、')}`,
                            );
                        } else {
                            // 如果没有找到同步配置，只在当前服务器添加
                            const member = await interaction.guild.members.fetch(interaction.user.id);
                            await member.roles.add(currentGuildConfig.roleApplication.creatorRoleId);
                            await interaction.editReply('✅ 审核通过，已为您添加创作者身份组。');
                        }
                    } catch (error) {
                        logTime(`同步添加创作者身份组时出错: ${error.message}`, true);
                        await interaction.editReply('❌ 添加身份组时出现错误，请联系管理员。');
                        return;
                    }
                } else {
                    await interaction.editReply('❌ 审核未通过，请获取足够正面反应后再申请。');
                }
            }, 3); // 用户指令优先级
        } catch (error) {
            logTime(`处理创作者身份组申请时出错: ${error}`, true);
            await interaction.editReply('❌ 处理申请时出现错误，请稍后重试。');
        }
    },

    // 处罚上诉模态框处理器
    appeal_modal: async interaction => {
        try {
            // 获取主服务器配置
            const guildIds = interaction.client.guildManager.getGuildIds();
            const mainGuildConfig = guildIds
                .map(id => interaction.client.guildManager.getGuildConfig(id))
                .find(config => config?.serverType === 'Main server');

            if (!mainGuildConfig?.courtSystem?.enabled) {
                await interaction.reply({
                    content: '❌ 主服务器未启用议事系统',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取主服务器实例
            const mainGuild = await interaction.client.guilds.fetch(mainGuildConfig.id);
            if (!mainGuild) {
                await interaction.reply({
                    content: '❌ 无法访问主服务器',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 从customId中获取处罚ID
            const punishmentId = interaction.customId.split('_')[2];
            if (!punishmentId) {
                await interaction.reply({
                    content: '❌ 无效的处罚ID',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取处罚记录 - 在buttons.js的appeal处理器中已经完成了检查
            const punishment = await PunishmentModel.getPunishmentById(parseInt(punishmentId));

            // 获取上诉内容
            const appealContent = interaction.fields.getTextInputValue('appeal_content');

            // 获取处罚执行者信息
            const executor = await interaction.client.users.fetch(punishment.executorId);

            // 获取议事区频道
            const courtChannel = await mainGuild.channels.fetch(mainGuildConfig.courtSystem.courtChannelId);
            if (!courtChannel) {
                await interaction.reply({
                    content: '❌ 无法访问议事频道',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 计算过期时间
            const expireTime = new Date(Date.now() + mainGuildConfig.courtSystem.appealDuration);

            // 先创建上诉流程（不含messageId）
            const process = await ProcessModel.createCourtProcess({
                type: 'appeal',
                targetId: interaction.user.id, // 上诉人（被处罚者）
                executorId: executor.id, // 处罚执行者
                expireAt: expireTime.getTime(),
                details: {
                    punishmentId: punishmentId,
                    appealContent: appealContent,
                },
            });

            // 构建描述文本
            let descriptionText = [
                `<@${interaction.user.id}> 上诉`,
                '',
                '**上诉理由：**',
                appealContent,
            ].join('\n');

            // 添加原处罚通知链接（如果有）
            const punishmentGuildConfig = interaction.client.guildManager.getGuildConfig(
                punishment.notificationGuildId,
            );
            if (punishment.notificationMessageId && punishmentGuildConfig?.moderationLogThreadId) {
                const notificationLink = `https://discord.com/channels/${punishment.notificationGuildId}/${punishmentGuildConfig.moderationLogThreadId}/${punishment.notificationMessageId}`;
                descriptionText += `\n\n**原处罚通知：**\n[点击查看](${notificationLink})`;
            }

            // 直接发送完整消息
            const message = await courtChannel.send({
                embeds: [
                    {
                        color: 0x5865f2,
                        title: '处罚上诉申请',
                        description: descriptionText,
                        fields: [
                            {
                                name: '处罚执行者',
                                value: `<@${executor.id}>`,
                                inline: true,
                            },
                            {
                                name: '处罚详情',
                                value: `${
                                    punishment.type === 'ban'
                                        ? '永久封禁'
                                        : `禁言 ${formatPunishmentDuration(punishment.duration)}`
                                }`,
                                inline: true,
                            },
                            {
                                name: '原处罚理由',
                                value: punishment.reason,
                                inline: false,
                            },
                        ],
                        timestamp: new Date(),
                        footer: {
                            text: `处罚ID: ${punishment.id} | 流程ID: ${process.id}`,
                        },
                    },
                ]
            });

            // 一次性更新流程记录
            await ProcessModel.updateStatus(process.id, 'pending', {
                messageId: message.id,
                details: {
                    ...process.details,
                    embed: message.embeds[0].toJSON(),
                },
            });

            // 记录上诉提交日志
            logTime(`用户 ${interaction.user.tag} 提交了对管理员 ${executor.tag} 的处罚上诉`);

            // 获取并更新原始上诉按钮消息
            try {
                // 从 customId 中获取消息 ID (格式: appeal_modal_punishmentId_messageId)
                const messageId = interaction.customId.split('_')[3];
                if (messageId) {
                    // 先尝试获取用户的DM channel
                    const dmChannel = await interaction.user.createDM();
                    if (dmChannel) {
                        try {
                            const originalMessage = await dmChannel.messages.fetch(messageId);
                            if (originalMessage) {
                                await originalMessage.edit({
                                    components: [
                                        {
                                            type: 1,
                                            components: [
                                                {
                                                    type: 2,
                                                    style: 4,
                                                    label: '撤回上诉',
                                                    custom_id: `revoke_appeal_${interaction.user.id}_${process.id}_${messageId}`,
                                                    emoji: { name: '↩️' },
                                                },
                                            ],
                                        },
                                    ],
                                });
                            }
                        } catch (error) {
                            // 如果获取消息失败，记录日志但不影响主流程
                            logTime(`获取原始上诉消息失败: ${error.message}`, true);
                        }
                    }
                }
            } catch (error) {
                logTime(`更新原始上诉消息失败: ${error.message}`, true);
                // 继续执行，不影响主流程
            }

            // 调度流程到期处理
            await globalTaskScheduler.getProcessScheduler().scheduleProcess(process, interaction.client);

            // 发送确认消息
            await interaction.editReply({
                content: '✅ 上诉申请已提交到议事区，请等待议员审议',
                flags: ['Ephemeral'],
            });
        } catch (error) {
            logTime(`处理上诉表单提交失败: ${error.message}`, true);
            await interaction.editReply({
                content: '❌ 处理上诉申请时出错，请稍后重试',
                flags: ['Ephemeral'],
            });
        }
    },

    // 议事模态框处理器
    submit_debate_modal: async interaction => {
        try {
            // 检查议事系统是否启用
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
            if (!guildConfig?.courtSystem?.enabled) {
                await interaction.editReply({
                    content: '❌ 此服务器未启用议事系统',
                });
                return;
            }

            // 获取用户输入
            const title = interaction.fields.getTextInputValue('debate_title');
            const reason = interaction.fields.getTextInputValue('debate_reason');
            const motion = interaction.fields.getTextInputValue('debate_motion');
            const implementation = interaction.fields.getTextInputValue('debate_implementation');
            let voteTime = interaction.fields.getTextInputValue('debate_vote_time');

            // 如果voteTime不以"天"结尾，添加"天"字
            if (!voteTime.endsWith('天')) {
                voteTime = voteTime + '天';
            }

            // 获取议事区频道
            const courtChannel = await interaction.guild.channels.fetch(guildConfig.courtSystem.courtChannelId);
            if (!courtChannel) {
                await interaction.editReply({
                    content: '❌ 无法获取议事频道',
                });
                return;
            }

            // 计算过期时间
            const expireTime = new Date(Date.now() + guildConfig.courtSystem.summitDuration);

            // 先创建议事流程（不含messageId）
            const process = await ProcessModel.createCourtProcess({
                type: 'debate',
                targetId: interaction.user.id,
                executorId: interaction.user.id,
                // 暂不设置messageId
                expireAt: expireTime.getTime(),
                details: {
                    title: title,
                    reason: reason,
                    motion: motion,
                    implementation: implementation,
                    voteTime: voteTime,
                },
            });

            // 发送包含完整信息的议事消息
            const message = await courtChannel.send({
                embeds: [
                    {
                        color: 0x5865f2,
                        title: title,
                        description: `提案人：<@${interaction.user.id}>\n\n议事截止：<t:${Math.floor(
                            expireTime.getTime() / 1000,
                        )}:R>`,
                        fields: [
                            {
                                name: '📝 原因',
                                value: reason,
                            },
                            {
                                name: '📋 动议',
                                value: motion,
                            },
                            {
                                name: '🔧 执行方案',
                                value: implementation,
                            },
                            {
                                name: '🕰️ 投票时间',
                                value: voteTime,
                            },
                        ],
                        timestamp: new Date(),
                        footer: {
                            text: `需 ${guildConfig.courtSystem.requiredSupports} 个支持，再次点击可撤销支持 | 流程ID: ${process.id}`,
                        },
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
                                custom_id: `support_debate_${interaction.user.id}_${interaction.user.id}`,
                                emoji: { name: '👍' },
                            },
                            {
                                type: 2,
                                style: 4,
                                label: '撤回提案',
                                custom_id: `revoke_process_${interaction.user.id}_debate`,
                                emoji: { name: '↩️' },
                            },
                        ],
                    },
                ],
            });

            // 一次性更新流程记录
            await ProcessModel.updateStatus(process.id, 'pending', {
                messageId: message.id,
                details: {
                    ...process.details,
                    embed: message.embeds[0].toJSON(),
                },
            });

            // 调度流程到期处理
            await globalTaskScheduler.getProcessScheduler().scheduleProcess(process, interaction.client);

            // 发送确认消息
            await interaction.editReply({
                content: `✅ 已提交议事申请\n👉 [点击查看议事消息](${message.url})`,
            });

            logTime(`用户 ${interaction.user.tag} 提交了议事 "${title}"`);
        } catch (error) {
            logTime(`提交议事申请失败: ${error.message}`, true);
            await interaction.editReply({
                content: '❌ 提交议事申请时出错，请稍后重试',
            });
        }
    },

    // AI新闻投稿模态框处理器
    news_submission_modal: async interaction => {
        await handleSubmission(interaction, 'news', '📰 新闻投稿：', 0x3498db); // 蓝色
    },

    // 社区意见投稿模态框处理器
    opinion_submission_modal: async interaction => {
        await handleSubmission(interaction, 'opinion', '💬 社区意见：', 0x2ecc71); // 绿色
    },
};

/**
 * 统一的模态框交互处理函数
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 */
export async function handleModal(interaction) {
    // 获取基础模态框ID
    let modalId;
    if (interaction.customId.includes('appeal_modal_')) {
        // 处理上诉模态框 ID (appeal_modal_123 -> appeal_modal)
        modalId = interaction.customId.split('_').slice(0, 2).join('_');
    } else {
        // 处理其他模态框 ID (保持原样)
        modalId = interaction.customId;
    }

    const handler = modalHandlers[modalId];

    if (!handler) {
        logTime(`未找到模态框处理器: ${interaction.customId}`, true);
        return;
    }

    try {
        await handler(interaction);
    } catch (error) {
        await handleInteractionError(interaction, error, 'modal');
    }
}

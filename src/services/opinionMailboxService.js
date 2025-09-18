import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { delay } from '../utils/concurrency.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

const messageIdsPath = join(process.cwd(), 'data', 'messageIds.json');
const opinionRecordsPath = join(process.cwd(), 'data', 'opinionRecords.json');

/**
 * 意见信箱服务类
 */
class OpinionMailboxService {
    constructor() {
        this.messageIds = this.loadMessageIds();
    }

    /**
     * 加载消息ID配置
     * @returns {Object} 消息ID配置对象
     */
    loadMessageIds() {
        return ErrorHandler.handleSilent(
            () => {
                const data = readFileSync(messageIdsPath, 'utf8');
                return JSON.parse(data);
            },
            "加载消息ID配置",
            {}
        );
    }

    /**
     * 保存消息ID配置
     * @param {Object} messageIds - 消息ID配置对象
     */
    saveMessageIds(messageIds) {
        ErrorHandler.handleServiceSync(
            () => {
                writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2), 'utf8');
                this.messageIds = messageIds;
            },
            "保存消息ID配置",
            { throwOnError: true }
        );
    }

    /**
     * 创建意见信箱消息内容
     * @returns {Object} 包含embed和components的消息对象
     */
    createMailboxMessage() {
        // 创建意见投稿按钮
        const opinionButton = new ButtonBuilder()
            .setCustomId('submit_opinion')
            .setLabel('提交社区意见')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('💬');

        const row = new ActionRowBuilder().addComponents(opinionButton);

        // 创建嵌入消息
        const embed = new EmbedBuilder()
            .setTitle('📮 社区意见信箱')
            .setDescription(
                [
                    '点击下方按钮，您可以向社区提交意见或建议：',
                    '',
                    '**提交要求：**',
                    '- 意见内容应当具体、建设性',
                    '- 可以是对社区的反馈或倡议',
                    '',
                    '管理组会查看并尽快处理您的意见',
                ].join('\n'),
            )
            .setColor(0x00aaff);

        return {
            embeds: [embed],
            components: [row],
        };
    }

    /**
     * 发送意见信箱消息到指定频道
     * @param {Channel} channel - 目标频道
     * @param {Client} client - Discord客户端
     * @returns {Promise<Message>} 发送的消息对象
     */
    async sendMailboxMessage(channel, client) {
        return await ErrorHandler.handleService(
            async () => {
                const messageContent = this.createMailboxMessage();
                const message = await channel.send(messageContent);

                // 更新消息ID记录
                this.updateMailboxMessageId(channel.id, message.id, client);

                return message;
            },
            "发送意见信箱消息",
            { throwOnError: true }
        );
    }

    /**
     * 更新频道的意见信箱消息ID记录
     * @param {string} channelId - 频道ID
     * @param {string} messageId - 消息ID
     * @param {Client} client - Discord客户端（用于获取主服务器ID）
     */
    updateMailboxMessageId(channelId, messageId, client) {
        ErrorHandler.handleServiceSync(
            () => {
                const guildId = client.guildManager.getMainServerId();

                // 确保结构存在
                this.messageIds[guildId] ??= {};
                this.messageIds[guildId].opinionMailbox ??= {};

                // 更新内存中的配置
                this.messageIds[guildId].opinionMailbox[channelId] = messageId;

                // 保存到文件
                this.saveMessageIds(this.messageIds);

                logTime(`[意见信箱] 已更新频道 ${channelId} 的消息ID记录: ${messageId}`);
            },
            "更新消息ID记录",
            { throwOnError: true }
        );
    }

    /**
     * 获取频道的意见信箱消息ID
     * @param {string} channelId - 频道ID
     * @param {Client} client - Discord客户端（用于获取主服务器ID）
     * @returns {string|null} 消息ID或null
     */
    getMailboxMessageId(channelId, client) {
        const guildId = client.guildManager.getMainServerId();
        return this.messageIds[guildId]?.opinionMailbox?.[channelId] || null;
    }

    /**
     * 删除旧的意见信箱消息
     * @param {Channel} channel - 频道对象
     * @param {Client} client - Discord客户端
     * @returns {Promise<boolean>} 删除是否成功
     */
    async deleteOldMailboxMessage(channel, client) {
        return await ErrorHandler.handleSilent(
            async () => {
                const oldMessageId = this.getMailboxMessageId(channel.id, client);
                if (!oldMessageId) {
                    return false;
                }

                const oldMessage = await channel.messages.fetch(oldMessageId);
                await oldMessage.delete();
                return true;
            },
            "删除旧意见信箱消息",
            false
        );
    }

    /**
     * 检查频道最后一条消息是否为BOT发送
     * @param {Channel} channel - 频道对象
     * @returns {Promise<boolean>} 最后一条消息是否为BOT发送
     */
    async isLastMessageFromBot(channel) {
        return await ErrorHandler.handleSilent(
            async () => {
                const messages = await channel.messages.fetch({ limit: 1 });
                if (messages.size === 0) {
                    return false;
                }

                const lastMessage = messages.first();
                return lastMessage.author.bot;
            },
            "检查频道最后消息",
            false
        );
    }

    /**
     * 维护意见信箱消息 - 检查并重新发送如果需要
     * @param {Client} client - Discord客户端
     * @param {string} channelId - 频道ID
     * @returns {Promise<boolean>} 是否进行了维护操作
     */
    async maintainMailboxMessage(client, channelId) {
        const result = await ErrorHandler.handleService(
            async () => {
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (!channel) {
                    throw new Error(`无法获取频道 ${channelId}`);
                }

                // 检查最后一条消息是否为BOT发送
                const isLastFromBot = await this.isLastMessageFromBot(channel);
                if (isLastFromBot) {
                    // 如果最后一条消息是BOT发送的，不需要维护
                    return false;
                }

                // 如果最后一条消息不是BOT发送的，删除旧的意见信箱入口并重新发送
                await this.deleteOldMailboxMessage(channel, client);

                // 发送新的意见信箱消息
                await this.sendMailboxMessage(channel, client);

                logTime(`[意见信箱] 已完成频道 ${channel.name} 的意见信箱入口维护`);
                return true;
            },
            `意见信箱维护 [频道 ${channelId}]`
        );

        return result.success ? result.data : false;
    }

    /**
     * 批量维护所有意见信箱消息
     * @param {Client} client - Discord客户端
     * @returns {Promise<number>} 维护的频道数量
     */
    async maintainAllMailboxMessages(client) {
        const result = await ErrorHandler.handleService(
            async () => {
                // 获取主服务器的频道列表
                const guildId = client.guildManager.getMainServerId();
                const channelIds = Object.keys(this.messageIds[guildId]?.opinionMailbox || {});
                let maintainedCount = 0;

                for (const channelId of channelIds) {
                    const maintained = await this.maintainMailboxMessage(client, channelId);
                    if (maintained) {
                        maintainedCount++;
                    }

                    // 添加延迟以避免API速率限制
                    await delay(1000);
                }

                return maintainedCount;
            },
            "意见信箱批量维护"
        );

        return result.success ? result.data : 0;
    }

    /**
     * 读取意见记录配置
     * @returns {Object} 意见记录配置对象
     */
    getOpinionRecords() {
        return ErrorHandler.handleSilent(
            () => JSON.parse(readFileSync(opinionRecordsPath, 'utf8')),
            "读取意见记录配置",
            { validSubmissions: [] }
        );
    }

    /**
     * 写入意见记录配置
     * @param {Object} records - 意见记录对象
     */
    saveOpinionRecords(records) {
        ErrorHandler.handleServiceSync(
            () => {
                writeFileSync(opinionRecordsPath, JSON.stringify(records, null, 4), 'utf8');
            },
            "保存意见记录配置",
            { throwOnError: true }
        );
    }

    /**
     * 更新意见记录
     * @param {string} userId - 用户ID
     * @param {string} submissionType - 投稿类型 (news/opinion)
     * @param {boolean} isApproved - 是否被批准
     * @param {Object} [submissionData] - 投稿数据 {title: string, content: string}
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async updateOpinionRecord(userId, submissionType, isApproved, submissionData = null) {
        return await ErrorHandler.handleService(
            async () => {
                if (!isApproved) {
                    // 如果是拒绝，不需要记录到文件中
                    return { message: '投稿已标记为不合理' };
                }

                // 读取现有记录
                const records = await this.getOpinionRecords();

                // 检查用户是否已有记录
                const existingUserRecord = records.validSubmissions.find(record => record.userId === userId);

                const submissionRecord = {
                    type: submissionType,
                    title: submissionData?.title || '未记录标题',
                    content: submissionData?.content || '未记录内容',
                    approvedAt: new Date().toISOString()
                };

                if (existingUserRecord) {
                    // 更新现有用户记录
                    existingUserRecord.submissions.push(submissionRecord);
                } else {
                    // 创建新用户记录
                    records.validSubmissions.push({
                        userId: userId,
                        submissions: [submissionRecord]
                    });
                }

                // 保存记录
                this.saveOpinionRecords(records);

                logTime(`[意见记录] 已记录用户 ${userId} 的有效${submissionType === 'news' ? '新闻投稿' : '社区意见'}: "${submissionRecord.title}"`);

                return { message: '投稿已标记为合理并记录' };
            },
            "更新意见记录",
            { userFriendly: true }
        );
    }

    /**
     * 检查用户是否有有效的投稿记录
     * @param {string} userId - 用户ID
     * @returns {boolean} 是否有有效记录
     */
    hasValidSubmissionRecord(userId) {
        return ErrorHandler.handleSilent(
            () => {
                const records = this.getOpinionRecords();
                const userRecord = records.validSubmissions.find(record => record.userId === userId);
                return userRecord && userRecord.submissions.length > 0;
            },
            "检查投稿记录",
            false
        );
    }
}

// 创建全局单例
export const opinionMailboxService = new OpinionMailboxService();
export default OpinionMailboxService;

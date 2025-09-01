import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    SlashCommandBuilder,
} from 'discord.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('创建特殊消息')
        .setDescription('创建特殊功能消息（如创作者申请、身份组同步）')
        .addStringOption(option =>
            option
                .setName('类型')
                .setDescription('选择消息类型')
                .setRequired(true)
                .addChoices(
                    { name: '创作者申请', value: 'creator_application' },
                    { name: '身份组同步', value: 'role_sync' },
                    { name: '提交议案', value: 'debate_submission' },
                    { name: '志愿者身份组管理', value: 'volunteer_role_management' },
                    { name: '新闻和意见信箱', value: 'opinion_mailbox' },
                ),
        )
        .addChannelOption(option =>
            option
                .setName('频道')
                .setDescription('选择要发送消息的频道')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread),
        ),

    async execute(interaction, guildConfig) {
        // 检查权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        const messageType = interaction.options.getString('类型');
        const targetChannel = interaction.options.getChannel('频道');

        try {
            // 创建不同类型的消息
            if (messageType === 'creator_application') {
                await createCreatorApplicationMessage(interaction, targetChannel);
            } else if (messageType === 'role_sync') {
                await createRoleSyncMessage(interaction, targetChannel);
            } else if (messageType === 'debate_submission') {
                await createDebateSubmissionMessage(interaction, targetChannel, guildConfig);
            } else if (messageType === 'volunteer_role_management') {
                await createVolunteerRoleManagementMessage(interaction, targetChannel, guildConfig);
            } else if (messageType === 'opinion_mailbox') {
                await createMailboxMessage(interaction, targetChannel, guildConfig);
            }
        } catch (error) {
            await handleCommandError(interaction, error, '创建特殊消息');
        }
    },
};

/**
 * 创建创作者申请消息
 * @param {Interaction} interaction - 斜杠命令交互对象
 * @param {Channel} channel - 目标频道
 */
async function createCreatorApplicationMessage(interaction, channel) {
    // 创建申请按钮
    const button = new ButtonBuilder().setCustomId('apply_creator_role').setLabel('申请').setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('创作者身份组自助申请')
        .setDescription(
            '请您点击下方按钮输入您的达到5个正面反应的作品帖子链接（形如 https://discord.com/channels/.../... ），bot会自动审核，通过则为您在所有服务器添加创作者身份组。',
        )
        .setColor(0x0099ff);

    // 发送消息
    await channel.send({
        embeds: [embed],
        components: [row],
    });

    logTime(`管理员 ${interaction.user.tag} 在频道 ${channel.name} 创建了创作者申请消息`);
    await interaction.editReply({
        content: `✅ 已在 <#${channel.id}> 创建创作者申请消息`,
    });
}

/**
 * 创建身份组同步消息
 * @param {Interaction} interaction - 斜杠命令交互对象
 * @param {Channel} channel - 目标频道
 */
async function createRoleSyncMessage(interaction, channel) {
    // 创建同步按钮
    const button = new ButtonBuilder().setCustomId('sync_roles').setLabel('同步身份组').setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('身份组手动同步')
        .setDescription(
            [
                '在您加入时，系统已进行了类脑服务器间身份组的自动同步，但由于API速率限制，可能存在部分未同步。',
                '若您发现自身身份组未同步，点击下方按钮可手动同步，而不需要经过准入答题。',
                '**可同步的身份组：**',
                '• 已验证 - 答题通过',
                '• 创作者',
                '• 赛博议员',
                '• 管理组 - 所有管理',
            ].join('\n'),
        )
        .setColor(0x0099ff);

    // 发送消息
    await channel.send({
        embeds: [embed],
        components: [row],
    });

    logTime(`管理员 ${interaction.user.tag} 在频道 ${channel.name} 创建了身份组同步消息`);
    await interaction.editReply({
        content: `✅ 已在 <#${channel.id}> 创建身份组同步消息`,
    });
}

/**
 * 创建议案提交消息
 * @param {Interaction} interaction - 斜杠命令交互对象
 * @param {Channel} channel - 目标频道
 * @param {Object} guildConfig - 服务器配置
 */
async function createDebateSubmissionMessage(interaction, channel, guildConfig) {
    // 检查议事系统是否启用
    if (!guildConfig.courtSystem?.enabled) {
        await interaction.editReply({
            content: '❌ 此服务器未启用议事系统，无法创建议案提交消息',
        });
        return;
    }

    // 创建议案提交按钮
    const button = new ButtonBuilder()
        .setCustomId('start_debate')
        .setLabel('提交议案')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📝');

    const row = new ActionRowBuilder().addComponents(button);

    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('🏛️ 议案预审核提交入口')
        .setDescription(
            [
                '点击下方按钮，您可以向议事区提交预审核的议案。',
                '',
                '**提交要求：**',
                '- 议案标题：简洁明了，不超过30字',
                '- 提案原因：说明提出此动议的原因',
                '- 议案动议：详细说明您的议案内容',
                '- 执行方案：说明如何落实此动议',
                '- 投票时间：建议的投票持续时间',
            ].join('\n'),
        )
        .setColor(0x5865f2)
        .setFooter({
            text: `提交后需 ${guildConfig.courtSystem.requiredSupports || 20} 个支持才能进入讨论阶段`,
        });

    // 发送消息
    await channel.send({
        embeds: [embed],
        components: [row],
    });

    logTime(`管理员 ${interaction.user.tag} 在频道 ${channel.name} 创建了议案提交入口`);
    await interaction.editReply({
        content: `✅ 已在 <#${channel.id}> 创建议案提交入口`,
    });
}

/**
 * 创建志愿者身份组管理消息
 * @param {Interaction} interaction - 斜杠命令交互对象
 * @param {Channel} channel - 目标频道
 * @param {Object} guildConfig - 服务器配置
 */
async function createVolunteerRoleManagementMessage(interaction, channel, guildConfig) {
    // 检查是否配置了志愿者身份组
    if (!guildConfig.roleApplication?.volunteerRoleId) {
        await interaction.editReply({
            content: '❌ 此服务器未配置志愿者身份组 (volunteerRoleId)',
        });
        return;
    }

    // 创建申请和退出按钮
    const applyButton = new ButtonBuilder()
        .setCustomId('apply_volunteer_role')
        .setLabel('申请志愿者身份组')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🙋');

    const exitButton = new ButtonBuilder()
        .setCustomId('exit_volunteer_role')
        .setLabel('退出志愿者身份组')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🚪');

    const row = new ActionRowBuilder().addComponents(applyButton, exitButton);

    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('🤝 社区志愿者身份组自助办理')
        .setDescription(
            [
                '点击下方按钮申请或退出志愿者身份组：',
                '',
                '**申请条件：**',
                '1. 加入达一个月，未处于被警告者状态',
                '2. 是创作者身份组的成员 或 在意见信箱中提出过合理建议',
                '**志愿者可参与社区重大决策的投票**',
            ].join('\n'),
        )
        .setColor(0x00aa00);

    // 发送消息
    await channel.send({
        embeds: [embed],
        components: [row],
    });

    logTime(`管理员 ${interaction.user.tag} 在频道 ${channel.name} 创建了志愿者身份组管理消息`);
    await interaction.editReply({
        content: `✅ 已在 <#${channel.id}> 创建志愿者身份组管理消息`,
    });
}

/**
 * 创建新闻和意见信箱消息
 * @param {Interaction} interaction - 斜杠命令交互对象
 * @param {Channel} channel - 目标频道
 * @param {Object} guildConfig - 服务器配置
 */
async function createMailboxMessage(interaction, channel, guildConfig) {
    // 检查是否配置了意见信箱频道
    if (!guildConfig.opinionMailThreadId) {
        await interaction.editReply({
            content: '❌ 此服务器未配置意见信箱频道 (opinionMailThreadId)',
        });
        return;
    }

    // 创建投稿按钮
    const newsButton = new ButtonBuilder()
        .setCustomId('submit_news')
        .setLabel('投稿AI新闻')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📰');

    const opinionButton = new ButtonBuilder()
        .setCustomId('submit_opinion')
        .setLabel('投稿社区意见')
        .setStyle(ButtonStyle.Success)
        .setEmoji('💬');

    const row = new ActionRowBuilder().addComponents(newsButton, opinionButton);

    // 创建嵌入消息
    const embed = new EmbedBuilder()
        .setTitle('📮 新闻和意见信箱')
        .setDescription(
            [
                '点击下方按钮，您可以向社区投稿AI新闻或提交社区意见：',
                '',
                '**投稿要求：**',
                '- 新闻投稿：分享值得关注的最新AI相关新闻',
                '- 意见投稿：提出对社区的建议或反馈',
                '',
                '管理组会查看并尽快处理您的投稿',
            ].join('\n'),
        )
        .setColor(0x00aaff);

    // 发送消息
    await channel.send({
        embeds: [embed],
        components: [row],
    });

    logTime(`管理员 ${interaction.user.tag} 在频道 ${channel.name} 创建了新闻和意见信箱消息`);
    await interaction.editReply({
        content: `✅ 已在 <#${channel.id}> 创建新闻和意见信箱消息`,
    });
}

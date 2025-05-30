import { Collection, Events } from 'discord.js';
import { handleButton } from '../handlers/buttons.js';
import { handleModal } from '../handlers/modals.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { handleCommandError, handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 创建一个用于存储冷却时间的集合
const cooldowns = new Collection();

// 默认冷却时间（秒）
const DEFAULT_COOLDOWN = 5;

/**
 * 处理Discord交互事件
 * @param {Interaction} interaction - Discord交互对象
 */
export default {
    name: Events.InteractionCreate,
    async execute(interaction) {
        // 处理按钮交互
        if (interaction.isButton()) {
            const buttonType = interaction.customId.split('_')[0];

            // 需要队列控制的按钮类型
            const queuedButtonTypes = ['court', 'vote', 'support'];

            if (queuedButtonTypes.includes(buttonType)) {
                const priority = buttonType === 'appeal' ? 4 : 3;

                try {
                    await globalRequestQueue.add(() => handleButton(interaction), priority);
                } catch (error) {
                    await handleInteractionError(interaction, error, 'button');
                }
                return;
            }

            // 其他按钮直接处理
            try {
                await handleButton(interaction);
            } catch (error) {
                await handleInteractionError(interaction, error, 'button');
            }
            return;
        }

        // 处理模态框提交
        if (interaction.isModalSubmit()) {
            try {
                await interaction.deferReply({ flags: ['Ephemeral'] });
                await handleModal(interaction);
            } catch (error) {
                await handleInteractionError(interaction, error, 'modal');
            }
            return;
        }

        // 处理自动补全请求
        if (interaction.isAutocomplete()) {
            try {
                const command = interaction.client.commands.get(interaction.commandName);
                if (!command || !command.autocomplete) {
                    return;
                }

                await command.autocomplete(interaction);
            } catch (error) {
                console.error(`自动补全处理错误: ${error}`);
                // 自动补全错误时尝试返回空数组，避免用户界面卡住
                try {
                    await interaction.respond([]);
                } catch (respondError) {
                    console.error(`响应自动补全错误: ${respondError}`);
                }
            }
            return;
        }

        // 处理斜杠命令
        if (interaction.isChatInputCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);
            if (!command) {
                logTime(`未找到命令 ${interaction.commandName}`, true);
                return;
            }

            // 根据命令的ephemeral属性决定是否使用Ephemeral模式
            const useEphemeral = command.ephemeral !== false;

            if (useEphemeral) {
                await interaction.deferReply({ flags: ['Ephemeral'] });
            } else {
                await interaction.deferReply();
            }

            try {
                const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
                if (!guildConfig) {
                    return interaction.editReply({
                        content: '此服务器尚未配置，无法使用命令。',
                        flags: ['Ephemeral'],
                    });
                }

                // 处理命令冷却时间
                const cooldownResult = await handleCooldown(interaction, command);
                if (cooldownResult) return cooldownResult;

                // 获取命令优先级并执行
                const priority = getPriorityByCommandName(command.data.name);
                await globalRequestQueue.add(() => command.execute(interaction, guildConfig), priority);
            } catch (error) {
                await handleCommandError(interaction, error, interaction.commandName);
            }
        }
    },
};

/**
 * 处理命令冷却时间
 * @param {Interaction} interaction 交互对象
 * @param {Command} command 命令对象
 * @returns {Promise<InteractionEditReplyOptions|null>} 如果在冷却中返回提示消息，否则返回null
 */
async function handleCooldown(interaction, command) {
    if (!cooldowns.has(command.data.name)) {
        cooldowns.set(command.data.name, new Collection());
    }

    const now = Date.now();
    const timestamps = cooldowns.get(command.data.name);
    const cooldownAmount = (command.cooldown ?? DEFAULT_COOLDOWN) * 1000;

    if (timestamps.has(interaction.user.id)) {
        const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

        if (now < expirationTime) {
            const timeLeft = (expirationTime - now) / 1000;
            return interaction.editReply({
                content: `⏳ 请等待 ${timeLeft.toFixed(1)} 秒后再使用 \`${command.data.name}\` 命令。`,
                flags: ['Ephemeral'],
            });
        }
    }

    timestamps.set(interaction.user.id, now);
    setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
    return null;
}

/**
 * 根据命令名称获取优先级
 * @param {string} commandName 命令名称
 * @returns {number} 优先级 (1-5)
 */
function getPriorityByCommandName(commandName) {
    const priorityMap = {
        adm_: 5, // 管理级任务最高优先级
        mod_: 4, // 管理员任务次高优先级
        user_: 3, // 用户任务中等优先级
        long_: 2, // 耗时后台任务较低优先级
    };

    const prefix = Object.keys(priorityMap).find(prefix => commandName.startsWith(prefix));
    return priorityMap[prefix] ?? 1; // 默认优先级为1
}

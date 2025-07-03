import { Context, Schema, Session } from 'koishi'

export const name = 'auto-tata-group-name'

export interface GuildConfig {
  // 群聊ID
  guildId: string
  // 该群的模板
  nameTemplate: string
}

export interface Config {
  // 群聊模板配置（配置了就表示监听该群）
  guildTemplates: GuildConfig[]
  // 成员变动后等待平台更新的延迟时间（毫秒）
  updateDelay: number
}

export const Config: Schema<Config> = Schema.object({
  guildTemplates: Schema.array(Schema.object({
    guildId: Schema.string()
      .description('群聊ID')
      .required(),
    nameTemplate: Schema.string()
      .description('该群的模板，使用{count}表示人数')
      .default('({count})🦦獭家一爱相亲相')
      .required()
  })).description('群聊模板配置，配置了就表示监听该群').default([]),
  updateDelay: Schema.number().description('成员变动后等待平台更新的延迟时间（毫秒）').default(2000).min(500).max(10000)
})

// 人数反转函数
function reverseNumber(num: number): string {
  return num.toString().split('').reverse().join('')
}

// 获取群的模板函数
function getGuildTemplate(guildId: string, config: Config): string | null {
  const guildConfig = config.guildTemplates.find(g => g.guildId === guildId)
  return guildConfig ? guildConfig.nameTemplate : null
}

// 获取监听的群列表
function getWatchedGuilds(config: Config): string[] {
  return config.guildTemplates.map(g => g.guildId)
}

export function apply(ctx: Context, config: Config) {
  // 监听群成员加入事件
  ctx.on('guild-member-added', async (session) => {
    await handleMemberChange(session, 'join')
  })

  // 监听群成员退出事件
  ctx.on('guild-member-removed', async (session) => {
    await handleMemberChange(session, 'leave')
  })

  async function handleMemberChange(session: Session, action: 'join' | 'leave') {
    try {
      const guildId = session.guildId
      if (!guildId) {
        return
      }

      const watchedGuilds = getWatchedGuilds(config)
      if (!watchedGuilds.includes(guildId)) {
        return // 不在监听列表中的群聊
      }

      // 获取当前群聊信息
      let guild
      try {
        guild = await session.bot.getGuild(guildId)
      } catch (error) {
        ctx.logger.warn(`无法获取群聊信息: ${guildId}`)
        return
      }

      // 延迟一段时间后获取成员数量，确保平台已更新成员列表
      ctx.logger.debug(`检测到成员${action === 'join' ? '加入' : '退出'}事件，等待平台更新成员列表...`)
      
      // 等待指定时间让平台更新成员列表
      await new Promise(resolve => setTimeout(resolve, config.updateDelay))
      
      // 尝试获取群成员数量
      let memberCount = 0
      let retryCount = 0
      const maxRetries = 3
      
      while (retryCount < maxRetries) {
        try {
          const members = await session.bot.getGuildMemberList(guildId)
          memberCount = members.data?.length || 0
          if (memberCount > 0) {
            break // 成功获取到成员数量
          }
        } catch (error) {
          ctx.logger.warn(`第${retryCount + 1}次获取群成员列表失败: ${error instanceof Error ? error.message : String(error)}`)
        }
        
        retryCount++
        if (retryCount < maxRetries) {
          // 等待1秒后重试
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
      
      if (memberCount === 0) {
        ctx.logger.error(`无法获取群 ${guildId} 的成员数量，跳过更新`)
        return
      }

      ctx.logger.debug(`获取到群 ${guildId} 当前成员数量: ${memberCount}`)

      // 获取该群的模板并生成新的群名（使用反转的人数）
      const nameTemplate = getGuildTemplate(guildId, config)
      if (!nameTemplate) {
        ctx.logger.error(`群 ${guildId} 没有配置模板`)
        return
      }

      const reversedCount = reverseNumber(memberCount)
      const newName = nameTemplate.replace('{count}', reversedCount)
      
      // 检查是否需要更新（避免重复更新）
      if (guild.name === newName) {
        ctx.logger.debug(`群名已经是目标名称，跳过更新: ${newName}`)
        return
      }

      // 尝试更新群名
      try {
        let success = false
        
        // 尝试多种API方法来更新群名
        // 方法1: 通用的 setGuildName
        if (!success && session.bot.internal?.setGuildName) {
          try {
            await session.bot.internal.setGuildName(guildId, newName)
            success = true
          } catch (error) {
            ctx.logger.debug(`setGuildName 失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        
        // 方法2: 通用的 editGuild
        if (!success && session.bot.internal?.editGuild) {
          try {
            await session.bot.internal.editGuild(guildId, { name: newName })
            success = true
          } catch (error) {
            ctx.logger.debug(`editGuild 失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        
        // 方法3: QQ 平台相关API
        if (!success && session.bot.internal) {
          const methods = [
            'set_group_name',
            'setGroupName', 
            'modify_group_info',
            'modifyGroupInfo'
          ]
          
          for (const method of methods) {
            if (session.bot.internal[method]) {
              try {
                await session.bot.internal[method](guildId, newName)
                success = true
                break
              } catch (error) {
                ctx.logger.debug(`${method} 失败: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          }
        }
        
        // 方法4: 尝试 OneBot API
        if (!success && session.bot.internal?.call) {
          try {
            await session.bot.internal.call('set_group_name', {
              group_id: guildId,
              group_name: newName
            })
            success = true
          } catch (error) {
            ctx.logger.debug(`OneBot API 失败: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        
        if (!success) {
          ctx.logger.warn(`当前平台不支持修改群名，平台: ${session.bot.platform}，可用方法: ${Object.keys(session.bot.internal || {}).filter(k => typeof session.bot.internal![k] === 'function').join(', ')}`)
          return
        }
        
        ctx.logger.info(`群聊 ${guildId} 名称已更新为: ${newName} (成员${action === 'join' ? '加入' : '退出'}, 实际人数: ${memberCount}, 显示人数: ${reversedCount})`)
      } catch (error) {
        ctx.logger.error(`更新群名失败: ${error instanceof Error ? error.message : String(error)}`)
      }

    } catch (error) {
      ctx.logger.error(`处理成员变动失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 添加手动更新群名的指令
  ctx.command('update-group-name [guildId]', '手动更新群聊名称')
    .option('count', '-c <count:number> 指定人数')
    .action(async ({ session, options }, guildId) => {
      const targetGuildId = guildId || session?.guildId
      if (!targetGuildId) {
        return '请指定群聊ID或在群聊中使用此命令'
      }

      const watchedGuilds = getWatchedGuilds(config)
      if (!watchedGuilds.includes(targetGuildId)) {
        return '该群聊没有配置模板'
      }

      if (!session) {
        return '无法获取会话信息'
      }

      try {
        let memberCount = options?.count
        
        if (memberCount === undefined) {
          // 获取实际成员数量
          try {
            const members = await session.bot.getGuildMemberList(targetGuildId)
            memberCount = members.data?.length || 0
          } catch (error) {
            return `无法获取群成员数量: ${error instanceof Error ? error.message : String(error)}`
          }
        }

        const nameTemplate = getGuildTemplate(targetGuildId, config)
        if (!nameTemplate) {
          return `群 ${targetGuildId} 没有配置模板`
        }

        const reversedCount = reverseNumber(memberCount)
        const newName = nameTemplate.replace('{count}', reversedCount)
        
        // 尝试更新群名
        try {
          let success = false
          
          // 尝试多种API方法来更新群名
          // 方法1: 通用的 setGuildName
          if (!success && session.bot.internal?.setGuildName) {
            try {
              await session.bot.internal.setGuildName(targetGuildId, newName)
              success = true
            } catch (error) {
              ctx.logger.debug(`setGuildName 失败: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          
          // 方法2: 通用的 editGuild
          if (!success && session.bot.internal?.editGuild) {
            try {
              await session.bot.internal.editGuild(targetGuildId, { name: newName })
              success = true
            } catch (error) {
              ctx.logger.debug(`editGuild 失败: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          
          // 方法3: QQ 平台相关API
          if (!success && session.bot.internal) {
            const methods = [
              'set_group_name',
              'setGroupName', 
              'modify_group_info',
              'modifyGroupInfo'
            ]
            
            for (const method of methods) {
              if (session.bot.internal[method]) {
                try {
                  await session.bot.internal[method](targetGuildId, newName)
                  success = true
                  break
                } catch (error) {
                  ctx.logger.debug(`${method} 失败: ${error instanceof Error ? error.message : String(error)}`)
                }
              }
            }
          }
          
          // 方法4: 尝试 OneBot API
          if (!success && session.bot.internal?.call) {
            try {
              await session.bot.internal.call('set_group_name', {
                group_id: targetGuildId,
                group_name: newName
              })
              success = true
            } catch (error) {
              ctx.logger.debug(`OneBot API 失败: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          
          if (!success) {
            return `当前平台不支持修改群名，平台: ${session.bot.platform}`
          }
          
          return `群名已更新为: ${newName} (实际人数: ${memberCount}, 显示人数: ${reversedCount})`
        } catch (error) {
          return `更新失败: ${error instanceof Error ? error.message : String(error)}`
        }
      } catch (error) {
        ctx.logger.error(`手动更新群名失败: ${error instanceof Error ? error.message : String(error)}`)
        return `操作失败: ${error instanceof Error ? error.message : String(error)}`
      }
    })

  // 添加配置查看指令
  ctx.command('group-name-config', '查看群名自动更新配置')
    .action(() => {
      const watchedGuilds = getWatchedGuilds(config)
      const result = [
        '群名自动更新配置:',
        `- 监听群聊: ${watchedGuilds.length > 0 ? watchedGuilds.join(', ') : '无'}`,
        `- 更新延迟: ${config.updateDelay}ms`
      ]
      
      if (config.guildTemplates.length > 0) {
        result.push('- 群聊模板:')
        config.guildTemplates.forEach(guild => {
          result.push(`  * ${guild.guildId}: ${guild.nameTemplate}`)
        })
      } else {
        result.push('- 群聊模板: 无')
      }
      
      return result.join('\n')
    })

  // 添加设置群模板的指令
  ctx.command('set-group-template <guildId> <template>', '设置群聊模板')
    .action(async ({ session }, guildId, template) => {
      if (!guildId || !template) {
        return '请提供群聊ID和模板内容'
      }

      if (!template.includes('{count}')) {
        return '模板必须包含 {count} 占位符'
      }

      // 查找是否已存在该群的配置
      const existingIndex = config.guildTemplates.findIndex(g => g.guildId === guildId)
      
      if (existingIndex >= 0) {
        // 更新现有配置
        config.guildTemplates[existingIndex].nameTemplate = template
        return `已更新群 ${guildId} 的模板为: ${template}`
      } else {
        // 添加新配置
        config.guildTemplates.push({ guildId, nameTemplate: template })
        return `已为群 ${guildId} 设置模板: ${template}`
      }
    })

  // 添加删除群模板的指令
  ctx.command('remove-group-template <guildId>', '删除群聊模板，停止监听该群')
    .action(async ({ session }, guildId) => {
      if (!guildId) {
        return '请提供群聊ID'
      }

      const index = config.guildTemplates.findIndex(g => g.guildId === guildId)
      if (index >= 0) {
        config.guildTemplates.splice(index, 1)
        return `已删除群 ${guildId} 的模板，停止监听该群`
      } else {
        return `群 ${guildId} 没有配置模板`
      }
    })

  // 添加API测试指令
  ctx.command('test-group-api [guildId]', '测试群聊API功能')
    .action(async ({ session }, guildId) => {
      const targetGuildId = guildId || session?.guildId
      if (!targetGuildId) {
        return '请指定群聊ID或在群聊中使用此命令'
      }

      if (!session) {
        return '无法获取会话信息'
      }

      try {
        // 获取群聊信息
        const guild = await session.bot.getGuild(targetGuildId)
        
        // 获取成员列表
        const members = await session.bot.getGuildMemberList(targetGuildId)
        const memberCount = members.data?.length || 0
        
        // 检查可用的API方法
        const availableMethods = []
        if (session.bot.internal?.setGuildName) availableMethods.push('setGuildName')
        if (session.bot.internal?.editGuild) availableMethods.push('editGuild')
        if (session.bot.internal?.set_group_name) availableMethods.push('set_group_name')
        if (session.bot.internal?.setGroupName) availableMethods.push('setGroupName')
        if (session.bot.internal?.modify_group_info) availableMethods.push('modify_group_info')
        if (session.bot.internal?.modifyGroupInfo) availableMethods.push('modifyGroupInfo')
        if (session.bot.internal?.call) availableMethods.push('call (OneBot)')
        
        const templateInfo = config.guildTemplates.find(g => g.guildId === targetGuildId)
        const currentTemplate = templateInfo ? templateInfo.nameTemplate : '未配置'
        
        return [
          `群聊API测试结果:`,
          `- 群聊ID: ${targetGuildId}`,
          `- 当前群名: ${guild.name}`,
          `- 成员数量: ${memberCount}`,
          `- 使用模板: ${currentTemplate}`,
          `- 监听状态: ${templateInfo ? '已监听' : '未监听'}`,
          `- 平台: ${session.bot.platform}`,
          `- 可用API方法: ${availableMethods.length > 0 ? availableMethods.join(', ') : '无'}`,
          `- 所有内部方法: ${Object.keys(session.bot.internal || {}).filter(k => typeof session.bot.internal![k] === 'function').join(', ')}`
        ].join('\n')
      } catch (error) {
        return `API测试失败: ${error instanceof Error ? error.message : String(error)}`
      }
    })

  // 添加平台调试指令
  ctx.command('debug-platform', '显示当前平台信息')
    .action(async ({ session }) => {
      if (!session) {
        return '无法获取会话信息'
      }

      const bot = session.bot
      const internal = bot.internal || {}
      
      return [
        `平台调试信息:`,
        `- 平台: ${bot.platform}`,
        `- 机器人ID: ${bot.selfId}`,
        `- 用户ID: ${bot.userId}`,
        `- 内部方法数量: ${Object.keys(internal).length}`,
        `- 函数方法: ${Object.keys(internal).filter(k => typeof internal[k] === 'function').join(', ')}`,
        `- 属性: ${Object.keys(internal).filter(k => typeof internal[k] !== 'function').join(', ')}`
      ].join('\n')
    })
}
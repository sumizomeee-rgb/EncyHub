-- 只提供可观测事实与条件；角色机制和 Boss 技能窗口由预设参数表达。
local function attribute(npc,kind)
    return npc.Attrib[CS.System.Convert.ToInt32(kind)].Value
end
-- 目录的列表参数不做深层校验；读取前限制数量和索引，避免任意属性遍历。
local function attributeIdsValid(ids)
    if type(ids)~='table' or getmetatable(ids)==BehaviorTreeJson.object then return false end
    local count=0
    for key,id in pairs(ids) do
        count=count+1
        if count>16 or type(key)~='number' or key%1~=0 or key<1 or key>16
            or type(id)~='number' or id%1~=0 or id<0 or id>2147483647 then return false end
    end
    for index=1,count do if ids[index]==nil then return false end end
    return true
end
local function observedAttribute(player,id)
    local function read(field)
        local ok,value=pcall(function()
            local value=BehaviorTreeFight.number(player.Attrib[CS.System.Convert.ToInt32(id)][field])
            if not value or value~=value or math.abs(value)==math.huge then error('attribute_unknown') end
            return value
        end)
        if ok then return true,value end
        return false,nil
    end
    -- Value/MaxValue 独立读取：缺上限不能把已知当前值变成未知。
    local known,value=read('Value')
    local maxKnown,max=read('MaxValue')
    return {known=known,value=value,maxKnown=maxKnown,max=max}
end
BehaviorTreeHandlers.fight_observe=function(ctx)
    local ids=ctx.params.playerAttributeIds
    if ids==nil then ids={} end
    if not attributeIdsValid(ids) then
        ctx.write(ctx.params.output,{error='invalid_player_attribute_ids'});return 'failed'
    end
    local fight=ctx.object(ctx.params.role)
    local role=fight:GetClientRole()

    local player=role and role.Npc
    if not player or player.IsDeleted then return 'failed' end
    if (ctx.params.stageId or 0)~=0 and fight.FightData.StageId~=ctx.params.stageId then
        ctx.write(ctx.params.output,{error='stage_mismatch'});return 'failed'
    end
    local allowed=not ctx.params.playerTemplateIds or #ctx.params.playerTemplateIds==0
    for _,id in ipairs(ctx.params.playerTemplateIds or {}) do if player.TemplateId==id then allowed=true end end
    if not allowed then
        ctx.write(ctx.params.output,{error='player_mismatch'});return 'failed'
    end
    ctx.run.combat=ctx.run.combat or {}
    local combat=ctx.run.combat
    combat.recentFrames=combat.recentFrames or {}
    combat.recent=combat.recent or {}
    local skill=player.SkillGroupComponent and player.SkillGroupComponent.CurrentSkill
    if skill then
        if skill~=combat.playerSkill or skill.Id~=combat.playerSkillId or (combat.playerFrame and skill.RunFrame<combat.playerFrame) then
            combat.recent[skill.Id]=ctx.now
            combat.recentFrames[skill.Id]=fight.Frame
        end
        combat.playerSkillId,combat.playerFrame=skill.Id,skill.RunFrame
    else combat.playerSkillId,combat.playerFrame=nil,nil end
    combat.playerSkill=skill
    for id,time in pairs(combat.recent) do if ctx.now-time>10 then combat.recent[id]=nil end end
    local searchKnown,enemy,distance=pcall(BehaviorTreeFight.enemy,fight,ctx.params.enemyTemplateId)
    if not searchKnown then enemy,distance=nil,nil end
    if enemy then combat.target=enemy end
    local target=enemy or combat.target
    local targetKnown,targetDeleted,targetDead=pcall(function()
        return target.IsDeleted,target.IsDead==true
    end)
    local targetLifeKnown,targetLife=false,nil
    if targetKnown and not targetDeleted then
        targetLifeKnown,targetLife=pcall(function()
            local value=BehaviorTreeFight.number(attribute(target,CS.XNpcAttribType.Life))
            if not value or value~=value or math.abs(value)==math.huge then error('target_life_unknown') end
            return value
        end)
        if not targetLifeKnown then targetLife=nil end
    end
    -- 限时清场也可能标记IsDead；只有真实生命归零才报告击杀。
    local dead=targetKnown and not targetDeleted and targetDead and targetLifeKnown and targetLife<=0
    local finishReason
    if searchKnown and not target then finishReason='target_not_observed'
    elseif not targetKnown then finishReason='target_unavailable'
    elseif targetDeleted then finishReason='target_deleted'
    elseif not targetLifeKnown then finishReason='target_life_unknown'
    elseif targetDead and targetLife>0 then finishReason='target_dead_with_life'
    elseif dead then finishReason='target_killed'
    elseif not searchKnown then finishReason='target_search_unknown'
    elseif not enemy then finishReason='target_unavailable'
    else finishReason='target_active' end
    local targetUnavailable=finishReason~='target_active' and finishReason~='target_killed' and finishReason~='target_not_observed'
    local enemySkill=enemy and enemy.SkillGroupComponent and enemy.SkillGroupComponent.CurrentSkill
    local function buffs(npc,kinds)
        local values=setmetatable({},BehaviorTreeJson.object)
        for _,kind in ipairs(kinds or {}) do values[tostring(kind)]=npc~=nil and fight.BuffManager:ExistByKind(npc,kind) or false end
        return values
    end
    local attributes=setmetatable({},BehaviorTreeJson.object)
    for _,id in ipairs(ids) do attributes[tostring(id)]=observedAttribute(player,id) end
    local life=attribute(player,CS.XNpcAttribType.Life)
    local lifeLost=combat.lastLife and math.max(0,combat.lastLife-life) or 0
    if lifeLost>0 then combat.lastLifeLossFrame=fight.Frame end
    combat.lastLife=life
    -- 只报告真实状态，不在观测节点里决定受击后要做什么。
    local controlKnown,control=pcall(function()
        local hit=player.CurrentAction==CS.XNpcAction.BeHit
        return {beHit=hit,beHitState=tostring(player.BeHitFSM.CurrentState),
            locked=player.IsCaught or (hit and not player.BeHitFSM:CanControl()),canMove=player:CanMove()}
    end)
    local invincibleKnown,invincible=pcall(function() return player:IsState(CS.XNpcState.Invincible) end)
    local immuneKnown,immune=pcall(function() return player:IsState(CS.XNpcState.ImmuneDamage) end)
    local px,py=BehaviorTreeFight.position(player)
    local dodge=player.Attrib[CS.System.Convert.ToInt32(CS.XNpcAttribType.DodgeEnergy)]
    local state={dodgeEnergy=dodge.Value,dodgeEnergyMax=dodge.MaxValue,
        dodgeEnergyRatio=dodge.MaxValue>0 and dodge.Value/dodge.MaxValue or 0,matrixTimes=fight.Result.Data.MatrixTimes,
        matrixReady=player.DodgeState==CS.XNpcDodgeState.Activate,
        playerAttributes=attributes,playerBuffs=buffs(player,ctx.params.playerBuffKinds),enemyBuffs=buffs(enemy,ctx.params.enemyBuffKinds),
        frame=fight.Frame,stageId=fight.FightData.StageId,playerTemplateId=player.TemplateId,
        life=life,lifeLost=lifeLost,framesSinceLifeLoss=combat.lastLifeLossFrame and fight.Frame-combat.lastLifeLossFrame or 1000000000,
        playerAction=tostring(player.CurrentAction),playerSkillFrame=skill and skill.RunFrame or 0,playerPosition={x=px,y=py},
        controlKnown=controlKnown,controlLocked=controlKnown and control.locked or false,
        beHit=controlKnown and control.beHit or false,beHitState=controlKnown and control.beHitState or 'unknown',canMove=controlKnown and control.canMove or false,
        invincibleKnown=invincibleKnown,invincible=invincibleKnown and invincible or false,
        immuneDamageKnown=immuneKnown,immuneDamage=immuneKnown and immune or false,
        energy=attribute(player,CS.XNpcAttribType.Energy),
        dodging=player.IsDodging==true,playerDead=player.IsDead,playerSkillId=skill and skill.Id or 0,exReady=player.IsExSkillActivate==true,
        finished=dead,finishReason=finishReason,targetLifeKnown=targetLifeKnown,targetLife=targetLife,
        enemyExists=enemy~=nil,enemy=setmetatable({},BehaviorTreeJson.object)}
    if enemy then
        local px,py=BehaviorTreeFight.position(player)
        local ex,ey=BehaviorTreeFight.position(enemy)
        local fx,fy=BehaviorTreeFight.number(enemy.Facing.x),BehaviorTreeFight.number(enemy.Facing.y)
        local length=math.sqrt(fx*fx+fy*fy)
        local dot=distance>0.001 and length>0 and ((px-ex)*fx+(py-ey)*fy)/(distance*length) or 1
        state.enemy={position={x=ex,y=ey},facing={x=fx,y=fy},facingDot=dot,id=enemy.Id,templateId=enemy.TemplateId,name=tostring(enemy.Name),distance=distance,
            life=targetLife,skillId=enemySkill and enemySkill.Id or 0,
            skillFrame=enemySkill and enemySkill.RunFrame or 0}
    end
    combat.observation=state
    ctx.write(ctx.params.output,state)
    return (player.IsDead or targetUnavailable) and 'failed' or 'succeeded'
end
BehaviorTreeHandlers.fight_enemy_window=function(ctx)
    local state=ctx.run.combat and ctx.run.combat.observation
    if not state or not state.enemyExists then return 'failed' end
    local enemy=state.enemy
    for _,window in ipairs(ctx.params.windows) do
        if enemy.skillId==window.skillId and enemy.skillFrame>=(window.fromFrame or 0)
            and enemy.skillFrame<=(window.toFrame or 100000) and enemy.distance<=(window.distance or 100000)
            and (enemy.facingDot or 1)>=(window.frontDotMin or -1) then
            return 'succeeded'
        end
    end
    return 'failed'
end
BehaviorTreeHandlers.fight_recent_skill=function(ctx)
    local recent=ctx.run.combat and ctx.run.combat.recent or {}
    for _,id in ipairs(ctx.params.skillIds) do
        local combat=ctx.run.combat
        local frame=combat and combat.observation and combat.observation.frame
        local recentFrame=combat and combat.recentFrames and combat.recentFrames[id]
        local matches=ctx.params.frames and ctx.params.frames>0 and frame and recentFrame and frame-recentFrame<=ctx.params.frames
        if matches or ((not ctx.params.frames or ctx.params.frames==0) and recent[id] and ctx.now-recent[id]<=(ctx.params.seconds or 4)) then return 'succeeded' end
    end
    return 'failed'
end
BehaviorTreeHandlers.fight_ball_ready=function(ctx)
    local fight=ctx.object(ctx.params.role)
    return BehaviorTreeFight.ball(fight,ctx.params)~=nil and 'succeeded' or 'failed'
end
BehaviorTreeHandlers.blackboard_compare=function(ctx)
    local value=ctx.run.blackboard
    for part in ctx.params.path:gmatch('[^.]+') do
        if type(value)~='table' then return 'failed' end
        value=value[part]
    end
    local expected=ctx.params.value
    if value==nil then return 'failed' end
    local op=ctx.params.operator
    local result
    if op=='eq' then result=value==expected
    elseif op=='ne' then result=value~=expected
    elseif type(value)=='number' and type(expected)=='number' then
        if op=='lt' then result=value<expected elseif op=='le' then result=value<=expected
        elseif op=='gt' then result=value>expected elseif op=='ge' then result=value>=expected end
    end
    return result and 'succeeded' or 'failed'
end

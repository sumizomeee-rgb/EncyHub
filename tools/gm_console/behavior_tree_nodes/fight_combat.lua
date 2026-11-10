-- 连招由树编排；这里提供带进展检测的普通移动和正常按键。
local function controllable(fight)
    return BehaviorTreeCapabilityChecks['fight.normal_attack'].available(fight)
end
local function touchDevice(fight)
    return fight.InputSystem:GetDevice(typeof(CS.XInputTouch))
end
local function aliveEnemy(player,npc)
    return npc and not npc.IsDeleted and not npc.IsDead and npc.IsActivate and npc.Role==nil
        and CS.XNpcManager.CheckTargetType(player,npc,CS.XNpcTargetType.Enemy)
        and (npc.RLNpc==nil or npc.RLNpc.ShowHp~=false)
        and npc.Attrib[CS.System.Convert.ToInt32(CS.XNpcAttribType.Life)].Value>0
end
local function number(value)
    return tonumber(value) or tonumber(tostring(value):match('^%s*(-?%d+%.?%d*)'))
end
local function position(npc)
    return number(npc.Position.x),number(npc.Position.y)
end
local function release(ctx)
    if ctx.memory.cleanup then ctx.memory.cleanup();ctx.memory.cleanup=nil end
end
BehaviorTreeCapabilityChecks['fight.input']={kind='fight',controllable=true,available=controllable}
BehaviorTreeCapabilityChecks['fight.approach']={kind='fight',controllable=true,available=function(fight)
    return controllable(fight) and touchDevice(fight)~=nil
end}
-- 用实际逻辑帧和位移判断受阻；不把硬直或技能锁移动误报成撞墙。
local function movementProgress(ctx,fight,player,enemy,px,py)
    ctx.run=ctx.run or {}
    ctx.run.combat=ctx.run.combat or {}
    local combat=ctx.run.combat
    combat.movement=combat.movement or {}
    local frame=fight.Frame
    local known,canMove=pcall(function() return player:CanMove() end)
    local progress=combat.movement[ctx.params]
    local retry=progress and progress.blockedUntil and frame<progress.blockedUntil
    if not progress or progress.enemyId~=enemy.Id or frame<progress.lastFrame
        or (not retry and frame-progress.lastFrame>2) then
        progress={enemyId=enemy.Id,lastFrame=frame,fromFrame=frame,x=px,y=py}
        combat.movement[ctx.params]=progress
    end
    retry=progress.blockedUntil and frame<progress.blockedUntil
    if progress.blockedUntil and not retry then
        progress.blockedUntil=nil
        progress.fromFrame,progress.x,progress.y=frame,px,py
    end
    progress.lastFrame=frame
    local displacement=math.sqrt((px-progress.x)^2+(py-progress.y)^2)
    if retry then return 'blocked_retry',progress,known,canMove,displacement end
    if not known or not canMove or not progress.canMove or displacement>=(ctx.params.minProgress or 0.2) then
        progress.fromFrame,progress.x,progress.y=frame,px,py
    elseif frame-progress.fromFrame>=(ctx.params.stuckFrames or 10) then
        progress.blockedUntil=frame+(ctx.params.blockedRetryFrames or 10)
        return 'no_movement',progress,known,canMove,displacement
    end
    progress.canMove=known and canMove or false
    return nil,progress,known,canMove,displacement
end
BehaviorTreeHandlers.fight_approach=function(ctx)
    local fight=ctx.object(ctx.params.role)
    if not controllable(fight) then
        release(ctx);ctx.write(ctx.params.output,{phase='failed',reason='movement_capability_lost'});return 'failed'
    end
    local player=fight:GetClientRole().Npc
    local px,py=position(player)
    local enemy,distance,dx,dy
    local it=fight.NpcManager:GetNpcTable():GetEnumerator()
    while it:MoveNext() do
        local npc=it.Current.Value
        if aliveEnemy(player,npc) then
            local x,y=position(npc)
            local vx,vy=x-px,y-py
            local d=math.sqrt(vx*vx+vy*vy)
            if not distance or d<distance then enemy,distance,dx,dy=npc,d,vx,vy end
        end
    end
    if not enemy then
        release(ctx)
        ctx.write(ctx.params.output,{phase='failed',reason='no_enemy'})
        return 'failed'
    end
    local report={npcId=enemy.Id,name=tostring(enemy.Name),distance=distance,life=enemy.Attrib[CS.System.Convert.ToInt32(CS.XNpcAttribType.Life)].Value,frame=fight.Frame}
    if (ctx.params.mode=='retreat' and distance>=ctx.params.distance) or (ctx.params.mode~='retreat' and ctx.params.mode~='orbit' and distance<=ctx.params.distance) then
        release(ctx)
        report.phase='arrived';ctx.write(ctx.params.output,report)
        return 'succeeded'
    end
    ctx.memory.started=ctx.memory.started or ctx.now
    if ctx.now-ctx.memory.started>=ctx.params.timeout then
        release(ctx);report.phase='failed';report.reason='movement_timeout';ctx.write(ctx.params.output,report);return 'failed'
    end
    local reason,progress,known,canMove,displacement=movementProgress(ctx,fight,player,enemy,px,py)
    report.phase=reason and 'failed' or 'moving'
    report.reason=reason
    report.canMoveKnown=known;report.canMove=known and canMove or false
    report.progressFrames=fight.Frame-progress.fromFrame;report.displacement=displacement
    report.retryAfterFrame=progress.blockedUntil
    ctx.write(ctx.params.output,report)
    if reason then release(ctx);return 'failed' end
    local touch=touchDevice(fight)
    if not touch then release(ctx);report.phase='failed';report.reason='movement_device_lost';ctx.write(ctx.params.output,report);return 'failed' end
    ctx.memory.cleanup=ctx.memory.cleanup or function() touch:SetMoveVec(CS.UnityEngine.Vector2.zero,0) end
    local rad=math.rad(tonumber(tostring(CS.XRLManager.Camera:GetEulerY())))
    if distance<0.001 then dx,dy,distance=1,0,1 end
    local x,y=dx/distance,dy/distance
    if ctx.params.mode=='retreat' then x,y=-x,-y end
    if ctx.params.mode=='orbit' then
        local radial=math.max(-0.8,math.min(0.8,(distance-ctx.params.distance)/2))
        local tangent=math.sqrt(1-radial*radial)
        x,y=x*radial-y*tangent,y*radial+x*tangent
    end
    local turn=math.rad(ctx.params.angleDegrees or 0)
    x,y=x*math.cos(turn)-y*math.sin(turn),x*math.sin(turn)+y*math.cos(turn)
    touch:SetMoveVec(CS.UnityEngine.Vector2(x*math.cos(rad)-y*math.sin(rad),x*math.sin(rad)+y*math.cos(rad)),1)
    return 'running'
end

-- 供后续业务节点复用观测与正常输入；运行调度仍只由同一个树内核负责。
local BehaviorTreeFight={available=controllable,position=position,number=number}
function BehaviorTreeFight.enemy(fight,templateId)
    local player=fight:GetClientRole().Npc
    local px,py=position(player)
    local best,distance
    local it=fight.NpcManager:GetNpcTable():GetEnumerator()
    while it:MoveNext() do
        local n=it.Current.Value
        if aliveEnemy(player,n) and (not templateId or templateId==0 or n.TemplateId==templateId) then
            local x,y=position(n)
            local d=math.sqrt((x-px)^2+(y-py)^2)
            if not distance or d<distance then best,distance=n,d end
        end
    end
    return best,distance
end
function BehaviorTreeFight.ball(fight,p)
    local control=fight:GetClientRole().Npc.FightBallControl
    if not control then return nil end
    local layer=CS.XFightBallControl.DEFAULT_BALL_LAYER
    local balls={}
    local reserve=0
    for i=0,control:GetFightContainerCount(layer)-1 do
        local ball=control:GetFightBallContainerData(layer,i)
        if ball and ball.IsReady then
            balls[#balls+1]={index=i,key=ball.Key,group=ball.GroupItemCount}
            if ball.Key==(p.reserveColor or 0) then reserve=reserve+1 end
        end
    end
    local best,group=nil,0
    for _,ball in ipairs(balls) do
        local remaining=reserve-(ball.key==p.reserveColor and ball.group or 0)
        if ((p.color or 0)==0 or ball.key==p.color) and (best==nil or (p.preferSmallGroup and ball.group<group) or (not p.preferSmallGroup and ball.group>group)) and ball.group>=(p.minGroup or 1)
            and ((p.reserveColor or 0)==0 or remaining>=1) then best,group=ball.index,ball.group end
    end
    return best,group
end

local function inputKey(fight,p)
    local action=p.action
    local keys=CS.XNpcOperationClickKey
    if action=='attack' then return keys.NormalAttackKey end
    if action=='dodge' then return keys.DodgeKey end
    if action=='ex' then
        if not fight:GetClientRole().Npc.IsExSkillActivate then return nil end
        return keys.ExSkillKey
    end
    local best=BehaviorTreeFight.ball(fight,p)
    if best==nil then return nil end
    return CS.System.Convert.ToByte(CS.System.Convert.ToInt32(keys.BallIndex1)+best)
end
BehaviorTreeHandlers.fight_input=function(ctx)
    local fight=ctx.object(ctx.params.role)
    if not controllable(fight) then
        release(ctx)
        ctx.write(ctx.params.output,{phase='failed',reason='input_capability_lost'})
        return 'failed'
    end
    local input=fight.InputControl
    if not ctx.memory.started then
        ctx.run=ctx.run or {}
        ctx.run.combat=ctx.run.combat or {}
        local combat=ctx.run.combat
        combat.inputs=combat.inputs or {}
        local last=combat.inputs[ctx.params.action]
        if last and ctx.now-last<(ctx.params.cooldownSeconds or 0) then return 'failed' end
        local key=inputKey(fight,ctx.params)
        if key==nil then
            release(ctx)
            ctx.write(ctx.params.output,{phase='failed',reason='key_unavailable',action=ctx.params.action})
            return 'failed'
        end
        if (ctx.params.directionPath or (ctx.params.direction and ctx.params.direction~='none')) and not ctx.memory.prepared then
            local dx,dy
            if ctx.params.directionPath then
                local value=ctx.run.blackboard
                for part in ctx.params.directionPath:gmatch('[^.]+') do value=type(value)=='table' and value[part] or nil end
                dx,dy=type(value)=='table' and value.x, type(value)=='table' and value.y
                if type(dx)~='number' or type(dy)~='number' or dx~=dx or dy~=dy
                    or math.abs(dx)==math.huge or math.abs(dy)==math.huge or dx*dx+dy*dy<0.000001 then
                    ctx.write(ctx.params.output,{phase='failed',reason='direction_unavailable',action=ctx.params.action})
                    return 'failed'
                end
                local length=math.sqrt(dx*dx+dy*dy);dx,dy=dx/length,dy/length
            else
                local enemy=BehaviorTreeFight.enemy(fight)
                if not enemy then return 'failed' end
                local px,py=position(fight:GetClientRole().Npc)
                local ex,ey=position(enemy)
                dx,dy=ex-px,ey-py
                local distance=math.sqrt(dx*dx+dy*dy)
                if distance<0.001 then dx,dy,distance=1,0,1 end
                dx,dy=dx/distance,dy/distance
                if ctx.params.direction=='away' then dx,dy=-dx,-dy
                elseif ctx.params.direction=='left' then dx,dy=-dy,dx
                elseif ctx.params.direction=='right' then dx,dy=dy,-dx end
            end
            ctx.memory.directionX,ctx.memory.directionY=dx,dy
            local touch=touchDevice(fight)
            if not touch then return 'failed' end
            ctx.memory.stopMove=function() touch:SetMoveVec(CS.UnityEngine.Vector2.zero,0) end
            ctx.memory.cleanup=ctx.memory.stopMove
            local rad=math.rad(CS.XRLManager.Camera:GetEulerY())
            touch:SetMoveVec(CS.UnityEngine.Vector2(dx*math.cos(rad)-dy*math.sin(rad),dx*math.sin(rad)+dy*math.cos(rad)),1)
            ctx.memory.prepared=ctx.now
            -- 先让输入系统读到方向，下一次 Update 再按键，避免锁住上一帧的方向。
            return 'running'
        end
        ctx.memory.started=ctx.now
        combat.inputs[ctx.params.action]=ctx.now
        ctx.memory.cleanup=function()
            if ctx.memory.stopMove then ctx.memory.stopMove();ctx.memory.stopMove=nil end
            input:OnClick(key,CS.XOperationClickType.KeyUp,false)
        end
        -- 正常 OnClick 自己执行按键门禁；不反射私有状态，也不强制输入。
        input:OnClick(key,CS.XOperationClickType.KeyDown,false)
        ctx.write(ctx.params.output,{phase='input_submitted',action=ctx.params.action,frame=fight.Frame,directionX=ctx.memory.directionX,directionY=ctx.memory.directionY})
        return 'running'
    end
    if ctx.now-ctx.memory.started<ctx.params.holdSeconds then return 'running' end
    ctx.memory.cleanup();ctx.memory.cleanup=nil
    -- 完成的是一次按键，不把输入提交写成技能命中或击杀。
    return 'succeeded'
end

-- 只读战斗计划：业务表描述判定，运行时补上真实锚点；不控制输入或修改角色。
do
local function number(v)
    return tonumber(v) or tonumber(tostring(v):match('^%s*(-?%d+%.?%d*)'))
end
local function point(v)
    if not v then return nil end
    local x,y=number(v.x),number(v.y)
    return x and y and {x=x,y=y} or nil
end
local function unit(x,y)
    local n=math.sqrt(x*x+y*y)
    if n<0.00001 then return 1,0 end
    return x/n,y/n
end
local function path(root,key)
    for part in tostring(key or ''):gmatch('[^.]+') do
        if type(root)~='table' then return nil end
        root=root[part]
    end
    return root
end
local function array()
    return setmetatable({},BehaviorTreeJson and BehaviorTreeJson.array or nil)
end
local function optional(read)
    local ok,v=pcall(read)
    return ok and v~=nil,v
end
local function timeRate(entity)
    local known,value=optional(function() return number(entity.TimeComponent.TimeScale) end)
    if not known or value<0 or value>16 then return false,1,1 end
    -- 实体Frame每次最多+1；位移仍使用原始TimeScale。
    return true,math.min(1,value),value
end
local function index(rows)
    local result={}
    for _,row in pairs(rows or {}) do if type(row)=='table' and row.id then result[row.id]=row end end
    return result
end
-- 矩形参数是全宽高；圆形和扇形的sizeX是半径。膨胀仅是保守圆界。
local function overlaps(shape,x,y,radius,fx,fy)
    local dx,dy=x-shape.x,y-shape.y
    local along=dx*fx+dy*fy
    local across=dx*fy-dy*fx
    local extra=radius+(shape.reach or 0)
    if shape.shape=='rect' then
        local a=math.max(0,math.abs(across)-shape.sizeX/2)
        local b=math.max(0,math.abs(along)-shape.sizeY/2)
        return a*a+b*b<=extra*extra
    elseif shape.shape=='circle' then
        return dx*dx+dy*dy<=(shape.sizeX+extra)^2
    elseif shape.shape=='sector' then
        local distance=math.sqrt(dx*dx+dy*dy)
        if distance>shape.sizeX+extra then return false end
        if distance<=extra then return true end
        local widen=math.asin(math.min(1,extra/distance))
        local angle=math.acos(math.max(-1,math.min(1,along/distance)))
        return angle<=math.min(math.pi,shape.sizeY*math.pi/360+widen)
    end
    return false
end
local function shapeKnown(model)
    if not model or model.shape=='none' then return model~=nil end
    return (model.shape=='rect' or model.shape=='circle' or model.shape=='sector')
        and type(model.sizeX)=='number' and model.sizeX>0
        and (model.shape=='circle' or (type(model.sizeY)=='number' and model.sizeY>0))
end
local function positive(value)
    return type(value)=='number' and value>0 and value<math.huge
end
local function crossesTarget(from,to,target,radius)
    if not target or not positive(radius) then return false end
    local dx,dy=to.x-from.x,to.y-from.y
    local tx,ty=target.x-from.x,target.y-from.y
    local length=dx*dx+dy*dy
    if length<.00001 then return false end
    local projection=tx*dx+ty*dy
    -- 已在目标圆内时允许外撤/切线；这里只排当前目标体积，不预测其他动态碰撞。
    if tx*tx+ty*ty<=radius*radius then return projection>.00001 end
    local fraction=math.max(0,math.min(1,projection/length))
    local x,y=tx-dx*fraction,ty-dy*fraction
    return x*x+y*y<radius*radius
end
local function terrain(fight,from,to,radius)
    return optional(function()
        if fight.Scene.ActiveTerrain.ThreeDMap~=false then error('map_unknown_or_3d') end
        local nav=fight.Scene.NavMesh
        local function blocked(x,y)
            local p=CS.Mathematics.fix2()
            local function fix(value)
                if FixParse then return FixParse(string.format('%.4f',value)) end
                return CS.FixExtension.Parse(string.format('%.4f',value))
            end
            p.x,p.y=fix(x),fix(y)
            local value=nav:CheckCellObstacle(nav:GetCell(p))
            if type(value)~='boolean' then error('terrain_result_unknown') end
            return value
        end
        -- 有限中心/圆界点检查，并不替代真实角色碰撞或完整寻路。
        for step=1,4 do
            local t=step/4
            local x,y=from.x+(to.x-from.x)*t,from.y+(to.y-from.y)*t
            if blocked(x,y) or blocked(x+radius,y) or blocked(x-radius,y)
                or blocked(x,y+radius) or blocked(x,y-radius) then return false end
        end
        return true
    end)
end
local function recentFailure(run,goal,dx,dy,frame,ttl)
    for _,failure in ipairs(run.navigationFailures or {}) do
        if type(failure.frame)=='number' and frame>=failure.frame and frame-failure.frame<=ttl then
            local p=failure.goal
            if p and (p.x-goal.x)^2+(p.y-goal.y)^2<1 then return true end
            local d=failure.direction
            if d and d.x*dx+d.y*dy>0.92 then return true end
        end
    end
    return false
end
BehaviorTreeHandlers.fight_plan=function(ctx)
    local fight=ctx.object(ctx.params.role)
    local frame=number(fight.Frame)
    local state=path(ctx.run.blackboard,ctx.params.observePath or 'combat')
    local profile=ctx.params.profile or {}
    local output=ctx.params.output or 'plan'
    ctx.run.threatPlans=ctx.run.threatPlans or {}
    local cache=ctx.run.threatPlans[output]
    if cache and cache.frame==frame then return 'succeeded' end
    local result={frame=frame,known=false,modelKnown=false,missilesKnown=false,pathKnown=false,
        currentDanger=false,predictedDanger=false,needDodge=false,needMove=false,safeToAttack=false,
        defending=true,reason='observation_unknown',hazards=array()}
    local function finish()
        ctx.run.threatPlans[output]={frame=frame}
        ctx.write(output,result)
        return 'succeeded'
    end
    if not frame or type(state)~='table' or state.frame~=frame or not state.playerPosition then return finish() end
    local player=fight:GetClientRole()
    player=player and player.Npc
    if not player or player.IsDeleted then result.reason='player_invalid';return finish() end
    local px,py=state.playerPosition.x,state.playerPosition.y
    local fps=profile.fps
    local radius,walkSpeed=profile.playerRadius,profile.walkSpeed
    if type(fps)~='number' or fps<=0 or type(radius)~='number' or radius<=0
        or type(walkSpeed)~='number' or walkSpeed<=0 then result.reason='profile_body_or_speed_unknown';return finish() end
    local horizon=math.max(2,math.min(30,ctx.params.horizonFrames or 14))
    local reaction=math.max(1,math.min(horizon,ctx.params.reactionFrames or 2))
    local dodge=type(profile.dodge)=='table' and profile.dodge or nil
    local dodgeHorizon=dodge and math.max(horizon,math.min(40,dodge.horizonFrames or 30)) or horizon
    local enemy=state.enemyExists and state.enemy or nil
    local skills,models=index(profile.skills),index(profile.missiles)
    local modelKnown=true
    local boss=ctx.run.combat and ctx.run.combat.target
    local enemyRateKnown,enemyRate,enemyRawRate=timeRate(boss)
    if not boss or (enemy and boss.Id~=enemy.id) then enemyRateKnown=false;enemyRate=1;enemyRawRate=1 end
    result.enemyTimeScaleKnown=enemyRateKnown
    if enemyRateKnown then result.enemyTimeScale=enemyRawRate end
    result.missileTimeScalesKnown=true
    local hazards={}
    local serial=cache and cache.serial or 0
    if not cache or cache.enemyId~=(enemy and enemy.id) or cache.skillId~=(enemy and enemy.skillId)
        or (enemy and cache.skillFrame and enemy.skillFrame<cache.skillFrame) then serial=serial+1 end
    local attack=tostring(enemy and enemy.id or 0)..':'..tostring(enemy and enemy.skillId or 0)..':'..serial
    result.attackIdentity=attack
    local function add(model,pos,face,start,stop,identity,source,reach,lock,motionStart)
        if not shapeKnown(model) then modelKnown=false;return end
        if model.shape=='none' then return end
        if #hazards>=64 then modelKnown=false;return end
        local fx,fy=unit(face.x,face.y)
        hazards[#hazards+1]={shape=model.shape,sizeX=model.sizeX,sizeY=model.sizeY or 0,
            x=pos.x,y=pos.y,fx=fx,fy=fy,start=math.max(0,start),stop=stop,
            speed=model.speed or 0,reach=reach or 0,lock=lock,identity=identity,source=source,
            motionStart=motionStart or 0,
            offsetX=model.offsetX or 0,offsetY=model.offsetY or 0}
    end
    local visited,accepted=0,0
    local missileOk,missileError=pcall(function()
        local it=fight.MissileManager:GetMissileTable():GetEnumerator()
        while it:MoveNext() do
            visited=visited+1
            if visited>128 then modelKnown=false;result.missilesTruncated=true;break end
            local m=it.Current
            local direct=optional(function() return m.Template end)
            if not direct then m=m.Value end
            local hostile=m.Npc and CS.XNpcManager.CheckTargetType(player,m.Npc,CS.XNpcTargetType.Enemy)
            local observedModel=hostile and models[m.Template.Id]
            local relevant=not observedModel or observedModel.shape~='none' or #(observedModel.children or {})>0
            if hostile and relevant and m.Alive~=false and m.Removed~=true then
                accepted=accepted+1
                if accepted>32 then modelKnown=false;result.missilesTruncated=true;break end
                local id=m.Template.Id
                local model=models[id]
                local pos,face,age=point(m.Position),point(m.Facing),number(m.CurrentMissileFrame)
                if not model or not pos or not face or not age then modelKnown=false
                else
                    local rateKnown,rate,rawRate=timeRate(m)
                    if not rateKnown then result.missileTimeScalesKnown=false;modelKnown=false end
                    if face.x*face.x+face.y*face.y<0.00001 and model.shape~='circle' then modelKnown=false end
                    if (model.speed or 0)~=0 and model.lineType~=1 then modelKnown=false end
                    if model.predictionSupported==false then modelKnown=false end
                    local live={shape=model.shape,sizeX=number(m.SizeX) or model.sizeX,
                        sizeY=number(m.SizeY) or model.sizeY,speed=(number(m.Speed) or model.speed or 0)*rawRate}
                    local life=model.lifeFrames
                    if not positive(life) then modelKnown=false;life=dodgeHorizon+age end
                    local repeatKnown,repeatDamage=optional(function() return m.Template.RepeatDamage end)
                    local hitKnown,hitPlayer=optional(function() return m.HitNpcSet:Contains(player.Id) end)
                    -- 不重复作用的本体已消费后不再耗闪；未知仍保留，父载体的子弹另算。
                    local consumed=repeatKnown and repeatDamage==false and hitKnown and hitPlayer==true
                    if not consumed then
                        add(live,pos,face,0,rate>0 and (life-age)/rate or dodgeHorizon,'m:'..tostring(m.Id),'missile')
                    end
                    -- 父载体不一定有碰撞盒；子弹锚在实际父位置，而非当前Boss脚下。
                    for _,child in ipairs(model.children or {}) do
                        local childModel=models[child.missileId]
                        local delay=child.delayFrames
                        if not childModel or type(delay)~='number' then modelKnown=false
                        elseif rate>0 and (delay-age)/rate>=-reaction and (delay-age)/rate<=dodgeHorizon then
                            if childModel.born~='parent' or childModel.direction~='parent' then modelKnown=false end
                            local childLife=childModel.lifeFrames
                            if childModel.shape~='none' and not positive(childLife) then modelKnown=false end
                            if not positive(childLife) then childLife=dodgeHorizon end
                            local dt=(delay-age)/rate
                            local fx,fy=unit(face.x,face.y)
                            local speed=live.speed/fps
                            local childPos={x=pos.x+fx*speed*math.max(0,dt),y=pos.y+fy*speed*math.max(0,dt)}
                            local predicted={}
                            for key,value in pairs(childModel) do predicted[key]=value end
                            predicted.speed=(childModel.speed or 0)*rawRate
                            add(predicted,childPos,face,dt-reaction,dt+childLife/rate+reaction,
                                'm:'..tostring(m.Id)..'/child:'..child.missileId,'child',nil,nil,dt)
                        end
                    end
                end
            end
        end
    end)
    result.missilesKnown=missileOk
    if not missileOk then result.missilesError=tostring(missileError):sub(1,180);modelKnown=false end
    if enemy and enemy.skillId~=0 then
        local skill=skills[enemy.skillId]
        if not skill then modelKnown=false
        else
            for castIndex,cast in ipairs(skill.casts or {}) do
                local dt=enemyRate>0 and (cast.frame-enemy.skillFrame)/enemyRate+(cast.spawnDelayFrames or 0) or math.huge
                local model=models[cast.missileId]
                local castRate=model and model.ignoreNpcTimeScale and 1 or enemyRate
                local life=model and model.lifeFrames
                local castLife=castRate>0 and (positive(life) and life or dodgeHorizon)/castRate or dodgeHorizon
                if not model then modelKnown=false
                elseif dt>=0 and dt<=dodgeHorizon then
                    if model.shape~='none' and not positive(life) then modelKnown=false end
                    if (model.shape~='none' or #(model.children or {})>0) and not enemyRateKnown then modelKnown=false end
                    if cast.conditionsUnknown or model.predictionSupported==false
                        or ((model.speed or 0)~=0 and model.lineType~=1) then modelKnown=false end
                    local lock=nil
                    if model.direction=='target' then lock=math.max(0,dt) end
                    for _,turn in ipairs(skill.turns or {}) do
                        local stop=turn.frame+(turn.durationFrames or 0)
                        if stop>=enemy.skillFrame and turn.frame<=cast.frame then
                            lock=math.max(lock or 0,(math.min(cast.frame,stop)-enemy.skillFrame)/math.max(.00001,enemyRate))
                        end
                    end
                    local reach=0
                    for _,move in ipairs(skill.moves or {}) do
                        local overlap=math.max(0,math.min(cast.frame,move.frame+(move.durationFrames or 0))-math.max(enemy.skillFrame,move.frame))
                        reach=reach+overlap*math.abs(move.speed or 0)/fps
                    end
                    if model.born=='target' or model.born=='parent' then
                        -- 已生成的目标/父锚点必须取活跃弹道；不拿当前目标位置冒充已锁定点。
                        if model.shape~='none' then modelKnown=false end
                        if #(model.children or {})>0 and dt>=0 then modelKnown=false end
                    else
                        local predicted={}
                        for key,value in pairs(model) do predicted[key]=value end
                        predicted.speed=(model.speed or 0)*(model.ignoreNpcTimeScale and 1 or enemyRawRate)
                        local anchor=enemy.position
                        if profile.usePendingEnemyAnchor==true and model.shape~='none' and dt>0 and dt<=1 then
                            local anchorKnown,pending=optional(function()
                                if not boss or boss.Id~=enemy.id then return nil end
                                return point(boss.MoveComponent.ToPosition)
                            end)
                            anchorKnown=anchorKnown and pending.x==pending.x and pending.y==pending.y
                                and math.abs(pending.x)<math.huge and math.abs(pending.y)<math.huge
                            result.pendingEnemyAnchorKnown=anchorKnown
                            result.pendingEnemyAnchorScope='next_fight_frame_only'
                            -- ToPosition含已排队的技能/动画位移；只替代下一帧出生点，不外推全段运动。
                            if anchorKnown then anchor=pending;reach=0 else modelKnown=false end
                        end
                        add(predicted,anchor,enemy.facing,dt-reaction,dt+castLife+reaction,
                            attack..'/cast:'..castIndex,'skill',reach,lock,dt)
                    end
                end
            end
        end
    end
    result.modelKnown=modelKnown
    result.known=modelKnown and missileOk
    result.radiusSource='profile_conservative_circle'
    result.controlKnown=state.controlKnown==true
    if result.controlKnown then result.controlLocked=state.controlLocked;result.canMove=state.canMove end
    result.protectionKnown=state.invincibleKnown==true or state.immuneDamageKnown==true
    result.protected=(state.invincibleKnown==true and state.invincible==true)
        or (state.immuneDamageKnown==true and state.immuneDamage==true)
    if not result.protected then
        result.protectionKnown=state.invincibleKnown==true and state.immuneDamageKnown==true
    end
    local function location(candidate,t)
        if candidate.dodge then
            -- 只有落点包络有观测依据；途中线性插值只用于粗排，不冒充真实动画曲线。
            local fraction=math.min(1,math.max(0,t-candidate.delay)*candidate.rate/candidate.settleFrames)
            return px+candidate.dx*candidate.distance*fraction,py+candidate.dy*candidate.distance*fraction,
                (candidate.spread+candidate.lateral)*fraction
        end
        local travel=math.min(candidate.distance,walkSpeed*math.max(0,t-reaction)/fps)
        return px+candidate.dx*travel,py+candidate.dy*travel
    end
    local function hit(h,candidate,t)
        if t<h.start or t>h.stop then return false end
        local fx,fy=h.fx,h.fy
        if h.lock then
            local tx,ty=location(candidate,math.max(0,h.lock))
            fx,fy=unit(tx-h.x,ty-h.y)
        end
        local shape={shape=h.shape,sizeX=h.sizeX,sizeY=h.sizeY,reach=h.reach,x=h.x,y=h.y}
        -- 活跃弹位置已含Offset；只预测尚未生成的Cast/子弹时加出生偏移。
        if h.source~='missile' then
            shape.x=shape.x+fx*h.offsetY+fy*h.offsetX
            shape.y=shape.y+fy*h.offsetY-fx*h.offsetX
        end
        local moving=math.max(0,t-h.motionStart)*h.speed/fps
        shape.x=shape.x+fx*moving;shape.y=shape.y+fy*moving
        local x,y,uncertainty=location(candidate,t)
        return overlaps(shape,x,y,radius+(uncertainty or 0),fx,fy)
    end
    local stay={dx=0,dy=0,distance=0}
    local earliest
    for _,h in ipairs(hazards) do
        local danger=false
        for t=0,horizon do
            if hit(h,stay,t) then danger=true;earliest=math.min(earliest or horizon,t);break end
        end
        if hit(h,stay,0) then result.currentDanger=true end
        if danger then result.predictedDanger=true end
        if #result.hazards<16 then result.hazards[#result.hazards+1]={identity=h.identity,source=h.source,
            fromFrame=frame+h.start,toFrame=frame+h.stop,danger=danger,position={x=h.x,y=h.y}} end
    end
    result.threatCount=#hazards
    result.earliestImpactFrames=earliest
    local towardX,towardY=1,0
    if enemy then towardX,towardY=unit(enemy.position.x-px,enemy.position.y-py) end
    local desired=math.max(0,ctx.params.desiredDistance or 3)
    local desiredOverride=path(ctx.run.blackboard,ctx.params.desiredDistancePath)
    if type(desiredOverride)=='number' and desiredOverride>0 and desiredOverride<=20 then desired=desiredOverride end
    result.desiredDistance=desired
    local distance=math.min(ctx.params.moveDistance or 3,walkSpeed*math.max(1,horizon-reaction)/fps)
    local best,bestRisk,bestScore
    local exitAcross=enemy and skills[enemy.skillId] and skills[enemy.skillId].exitAcrossFacing==true
    local facing=enemy and enemy.facing
    local facingKnown=facing and type(facing.x)=='number' and type(facing.y)=='number'
        and facing.x==facing.x and facing.y==facing.y and math.abs(facing.x)<math.huge
        and math.abs(facing.y)<math.huge and facing.x*facing.x+facing.y*facing.y>.00001
    local facingX,facingY=0,0
    if facingKnown then facingX,facingY=unit(facing.x,facing.y) end
    local function acrossFacing(candidate)
        return facingKnown and math.abs(candidate.dx*facingX+candidate.dy*facingY)<=math.sqrt(.5)+.000001
    end
    if exitAcross then result.exitAcrossFacing={enabled=true,facingKnown=facingKnown==true} end
    local function choosePool(candidates,diagnostic)
        if not exitAcross then return candidates,false end
        local across={}
        for _,candidate in ipairs(candidates) do
            if acrossFacing(candidate) then across[#across+1]=candidate end
        end
        local fallback=#across==0
        result.exitAcrossFacing[diagnostic]=fallback
        return fallback and candidates or across,not fallback
    end
    local selectedAt=frame
    local heldGoal=false
    local knownPaths=0
    local safeCandidates=0
    local function candidateRisk(candidate)
        local risk=0
        for _,h in ipairs(hazards) do
            for t=reaction,horizon do if hit(h,candidate,t) then risk=risk+1 end end
        end
        return risk
    end
    local function distanceScore(goal)
        return enemy and math.abs(math.sqrt((goal.x-enemy.position.x)^2+(goal.y-enemy.position.y)^2)-desired) or 0
    end
    local walkCandidates={}
    for i=0,7 do
        local angle=i*math.pi/4
        local dx=towardX*math.cos(angle)-towardY*math.sin(angle)
        local dy=towardX*math.sin(angle)+towardY*math.cos(angle)
        local goal={x=px+dx*distance,y=py+dy*distance}
        local known,clear=terrain(fight,{x=px,y=py},goal,radius)
        if known then knownPaths=knownPaths+1 end
        if known and clear and not crossesTarget({x=px,y=py},goal,enemy and enemy.position,dodge and dodge.avoidTargetRadius)
            and not recentFailure(ctx.run,goal,dx,dy,frame,ctx.params.failureTTLFrames or 40) then
            walkCandidates[#walkCandidates+1]={dx=dx,dy=dy,distance=distance,goal=goal}
        end
    end
    -- 业务招式可优先脱离实际朝向的直线；侧向受阻才回退，仍不代表安全。
    local walkPool,walkAcrossOnly=choosePool(walkCandidates,'walkFallback')
    for _,candidate in ipairs(walkPool) do
        local risk=candidateRisk(candidate)
        if risk==0 then safeCandidates=safeCandidates+1 end
        local score=distanceScore(candidate.goal)
        if not best or risk<bestRisk or (risk==bestRisk and score<bestScore) then best,bestRisk,bestScore=candidate,risk,score end
    end
    -- 相同风险下不要因距离评分微差每帧左右摆；旧目标也必须重新验危险和地形。
    if cache and cache.selectedGoal and cache.desiredDistance==desired then
        local oldGoal=cache.selectedGoal
        local dx,dy=oldGoal.x-px,oldGoal.y-py
        local length=math.sqrt(dx*dx+dy*dy)
        if length>0.4 then
            dx,dy=dx/length,dy/length
            local known,clear=terrain(fight,{x=px,y=py},oldGoal,radius)
            if known and clear and (not walkAcrossOnly or acrossFacing({dx=dx,dy=dy}))
                and not crossesTarget({x=px,y=py},oldGoal,enemy and enemy.position,dodge and dodge.avoidTargetRadius)
                and not recentFailure(ctx.run,oldGoal,dx,dy,frame,ctx.params.failureTTLFrames or 40) then
                local old={dx=dx,dy=dy,distance=length,goal=oldGoal}
                local risk,score=candidateRisk(old),distanceScore(oldGoal)
                if not best or risk<bestRisk or (risk==bestRisk and
                    (frame-(cache.selectedAt or frame)<6 or score<=bestScore+0.5)) then
                    best,bestRisk,bestScore=old,risk,score
                    selectedAt=cache.selectedAt or frame;heldGoal=true
                    if risk==0 then safeCandidates=math.max(1,safeCandidates) end
                end
            end
        end
    end
    result.pathKnown=knownPaths==8
    result.pathScope='finite_terrain_samples'
    result.safeCandidateCount=safeCandidates
    result.directionKnown=best~=nil
    result.goalSafe=best~=nil and bestRisk==0 and result.known
    result.candidateRisk=bestRisk
    result.defending=result.predictedDanger or not result.known
    result.needMove=result.defending or (enemy and math.abs(enemy.distance-desired)>0.8) or false
    -- 当前站位安全时，不能为了接近而主动选一个已知危险落点。
    if not result.defending and bestRisk and bestRisk>0 then best=nil;result.directionKnown=false;result.goalSafe=false end
    if best and result.needMove then result.goal=best.goal;result.direction={x=best.dx,y=best.dy} end
    result.goalSelection=heldGoal and 'held_rechecked' or 'new'
    result.selectedAtFrame=selectedAt
    -- 正常走位能脱离时优先省闪；保护中不重复闪，不可控/未知时不声称可以闪。
    result.needDodge=result.known and result.predictedDanger and result.controlKnown and state.controlLocked==false
        and result.protectionKnown and not result.protected and
        (result.currentDanger or (earliest and earliest<=reaction)
            or (safeCandidates==0 and earliest and earliest<=math.max(reaction,ctx.params.dodgeLeadFrames or 3))) or false
    result.safeToAttack=result.known and not result.predictedDanger and result.controlKnown and state.controlLocked==false
    if dodge then
        local choice={known=false,landingSafe=false,directionKnown=false,reason='dodge_model_unknown',
            scope='observed_bounds_rank_only',protectionDiscounted=false}
        result.dodge=choice
        local lo,hi=dodge.distanceMin,dodge.distanceMax
        local settle,recovery=dodge.settleFrames,dodge.recoveryFrame
        local lateral=dodge.lateralMargin
        if not result.needDodge then choice.reason='not_needed'
        elseif type(lo)=='number' and type(hi)=='number' and lo>0 and hi>=lo and hi<=12
            and type(settle)=='number' and settle>0 and settle<=40
            and type(recovery)=='number' and recovery>0 and recovery<=40
            and type(lateral)=='number' and lateral>=0 and lateral<=3 then
            local rateKnown,rate,rawRate=timeRate(player)
            choice.playerTimeScaleKnown=rateKnown
            if rateKnown then choice.playerTimeScale=rawRate end
            rate=rate>0 and rate or 1
            local delay=math.max(0,math.min(4,dodge.inputDelayFrames or 1))
            local postFrom=delay+math.max(0,recovery-1)/rate
            local chosen,chosenFollowups,chosenPost,chosenTravel,chosenScore
            local dodgeCandidates={}
            for i=0,7 do
                local angle=i*math.pi/4
                local dx=towardX*math.cos(angle)-towardY*math.sin(angle)
                local dy=towardX*math.sin(angle)+towardY*math.cos(angle)
                local goal={x=px+dx*(lo+hi)/2,y=py+dy*(lo+hi)/2}
                local outer={x=px+dx*hi,y=py+dy*hi}
                local inner={x=px+dx*lo,y=py+dy*lo}
                local outerKnown,outerClear=terrain(fight,{x=px,y=py},outer,radius+lateral)
                local innerKnown,innerClear=terrain(fight,{x=px,y=py},inner,radius+lateral)
                if outerKnown and innerKnown and outerClear and innerClear
                    and not crossesTarget({x=px,y=py},outer,enemy and enemy.position,dodge.avoidTargetRadius)
                    and not recentFailure(ctx.run,outer,dx,dy,frame,ctx.params.failureTTLFrames or 40) then
                    local candidate={dodge=true,dx=dx,dy=dy,distance=(lo+hi)/2,spread=(hi-lo)/2,lateral=lateral,
                        rate=rate,delay=delay,settleFrames=settle,goal=goal}
                    dodgeCandidates[#dodgeCandidates+1]=candidate
                end
            end
            local dodgePool=choosePool(dodgeCandidates,'dodgeFallback')
            for _,candidate in ipairs(dodgePool) do
                    local followups,postRisk,travelRisk=0,0,0
                    for _,h in ipairs(hazards) do
                        local later=false
                        for t=0,dodgeHorizon do
                            if hit(h,candidate,t) then
                                travelRisk=travelRisk+1
                                if t>=postFrom then postRisk=postRisk+1;later=true end
                            end
                        end
                        if later then followups=followups+1 end
                    end
                    local score=distanceScore(candidate.goal)
                    if not chosen or followups<chosenFollowups or (followups==chosenFollowups and
                        (postRisk<chosenPost or (postRisk==chosenPost and
                            (travelRisk<chosenTravel or (travelRisk==chosenTravel and score<chosenScore))))) then
                        chosen,chosenFollowups,chosenPost,chosenTravel,chosenScore=candidate,followups,postRisk,travelRisk,score
                    end
            end
            local cost=dodge.costRatio or 0.25
            choice.costRatio=cost
            choice.canAfford=type(state.dodgeEnergyRatio)=='number' and state.dodgeEnergyRatio>=cost
            choice.reserveAfter=type(state.dodgeEnergyRatio)=='number' and state.dodgeEnergyRatio-cost or nil
            choice.budgetTight=choice.reserveAfter~=nil and choice.reserveAfter<(dodge.reserveRatio or cost) or false
            choice.postFromFrames=postFrom
            choice.horizonFrames=dodgeHorizon
            choice.terrainScope='finite_terrain_samples'
            if chosen then
                choice.directionKnown=true;choice.direction={x=chosen.dx,y=chosen.dy};choice.goal=chosen.goal
                choice.distanceMin=lo;choice.distanceMax=hi;choice.lateralMargin=lateral
                choice.followupThreats=chosenFollowups;choice.postRisk=chosenPost;choice.travelRisk=chosenTravel
                choice.landingClearInModel=postFrom<=dodgeHorizon and chosenPost==0
                -- 当前角色只有观测包络，未解析完整动画位移/碰撞。不给精确安全保证。
                choice.reason=postFrom>dodgeHorizon and 'recovery_beyond_horizon' or 'lowest_followup_risk'
                choice.recommended=result.needDodge and choice.canAfford
            else choice.reason='no_terrain_candidate' end
        end
    end
    if not result.known then result.reason=not missileOk and 'missile_observation_unknown' or 'threat_model_unknown'
    elseif result.protected and result.predictedDanger then result.reason='protected_reposition'
    elseif result.needDodge then result.reason='walking_cannot_clear_in_time'
    elseif result.predictedDanger and best then result.reason=bestRisk==0 and 'walk_clear' or 'least_risk_reposition'
    elseif result.predictedDanger then result.reason='no_clear_candidate'
    elseif result.needMove then result.reason='adjust_distance'
    else result.reason='known_clear' end
    if not result.pathKnown then result.pathReason='terrain_query_unknown' end
    cache={frame=frame,serial=serial,enemyId=enemy and enemy.id,skillId=enemy and enemy.skillId,skillFrame=enemy and enemy.skillFrame,
        selectedGoal=result.goal,selectedAt=selectedAt,desiredDistance=desired}
    ctx.run.threatPlans[output]=cache
    ctx.write(output,result)
    return 'succeeded'
end
end

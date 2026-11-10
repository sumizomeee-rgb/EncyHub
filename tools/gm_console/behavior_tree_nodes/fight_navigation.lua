-- 只负责沿完整地形路线正常行走；目标是否避开攻击由上游策略判断。
do
local function finite(value)
    return type(value)=='number' and value==value and math.abs(value)<100000
end
local function point(value)
    if value==nil then return nil end
    local x,y=BehaviorTreeFight.number(value.x),BehaviorTreeFight.number(value.y)
    if finite(x) and finite(y) then return {x=x,y=y} end
end
local function distance(a,b)
    return math.sqrt((a.x-b.x)^2+(a.y-b.y)^2)
end
local function fix(value)
    local text=string.format('%.4f',value)
    if FixParse then return FixParse(text) end
    return CS.FixExtension.Parse(text)
end
local function fixPoint(value)
    local result=CS.Mathematics.fix2()
    result.x,result.y=fix(value.x),fix(value.y)
    return result
end
local function release(ctx)
    if ctx.memory.cleanup then
        local cleanup=ctx.memory.cleanup
        ctx.memory.cleanup=nil
        cleanup()
    end
end
local function goalFrom(ctx)
    local value=ctx.run.blackboard
    for part in ctx.params.goalPath:gmatch('[^.]+') do
        if type(value)~='table' then return nil end
        value=value[part]
    end
    return type(value)=='table' and point(value) or nil
end
-- 格查询包含起终点；额外拒绝对角穿角，不能只看可能漏端点的CheckLineObstacle。
local function segment(nav,from,to)
    local length=distance(from,to)
    if length>40 then return false,'path_limit' end
    local function obstacle(x,y)
        local value
        if y==nil then value=nav:CheckCellObstacle(x) else value=nav:CheckCellObstacle(x,y) end
        if type(value)~='boolean' then error('terrain_result_unknown') end
        return value
    end
    local previous
    for i=0,math.max(1,math.ceil(length/0.25)) do
        local t=i/math.max(1,math.ceil(length/0.25))
        local pos=fixPoint({x=from.x+(to.x-from.x)*t,y=from.y+(to.y-from.y)*t})
        local cell=nav:GetCell(pos)
        if obstacle(cell) then return false,'terrain_blocked' end
        if previous and previous.x~=cell.x and previous.y~=cell.y then
            if obstacle(previous.x,cell.y) or obstacle(cell.x,previous.y) then
                return false,'terrain_blocked'
            end
        end
        previous={x=cell.x,y=cell.y}
    end
    local line=nav:CheckLineObstacle(fixPoint(from),fixPoint(to),fix(0))
    if type(line)~='boolean' then error('terrain_result_unknown') end
    if line then return false,'terrain_blocked' end
    return true
end
local function route(fight,from,goal)
    local nav=fight.Scene.NavMesh
    local valid,reason=segment(nav,from,from)
    if valid then valid,reason=segment(nav,goal,goal) end
    if not valid then return nil,reason end
    valid,reason=segment(nav,from,goal)
    if valid then return {goal},nil,'direct_terrain' end
    local list=CS.System.Collections.Generic.List(CS.Mathematics.fix2)()
    local found,returned=fight.PathManager.PathFinder:Detour(fixPoint(from),fixPoint(goal),list)
    if returned~=nil then list=returned end
    if type(found)~='boolean' then return nil,'path_result_unknown','PathFinder.Detour' end
    local count=list.Count
    -- SmoothPath可能在false时仍追加请求终点，绝不跟随这个数组。
    if not found then return nil,count>0 and 'path_partial' or 'path_unreachable','PathFinder.Detour' end
    if count<1 or count>64 then return nil,'path_invalid','PathFinder.Detour' end
    local points,total,prior={},0,from
    local lengthLimit=math.min(40,distance(from,goal)*4+4)
    for i=0,count-1 do
        local nextPoint=point(list[i])
        if not nextPoint then return nil,'path_invalid','PathFinder.Detour' end
        total=total+distance(prior,nextPoint)
        if total>lengthLimit then return nil,'path_detour_excess','PathFinder.Detour' end
        valid,reason=segment(nav,prior,nextPoint)
        if not valid then return nil,reason,'PathFinder.Detour' end
        points[#points+1]=nextPoint
        prior=nextPoint
    end
    if distance(prior,goal)>0.1 then return nil,'path_invalid','PathFinder.Detour' end
    return points,nil,'PathFinder.Detour'
end
local function report(ctx,fight,phase,reason,extra)
    local m=ctx.memory
    local value={phase=phase,reason=reason,frame=fight and fight.Frame,goal=m.goal,
        waypoint=m.points and m.points[m.index],waypointIndex=m.index,pathPoints=m.points,
        replans=m.replans or 0,source=m.source,pathFrame=m.pathFrame,
        goalChangedFrame=m.goalChangedFrame,
        clearanceKnown=false,dynamicCollisionChecked=false,threatChecked=false}
    for key,item in pairs(extra or {}) do value[key]=item end
    ctx.write(ctx.params.output,value)
    return phase=='failed' and 'failed' or phase=='arrived' and 'succeeded' or 'running'
end
local function fail(ctx,fight,reason,extra)
    release(ctx)
    local geometric=reason=='path_partial' or reason=='path_unreachable' or reason=='terrain_blocked'
        or reason=='replan_limit' or reason=='blocked_retry' or reason=='path_detour_excess'
    local m=ctx.memory
    if geometric and not m.failureRecorded and m.goal and m.position then
        local length=distance(m.position,m.goal)
        if length>0.0001 then
            -- 给上游候选评分共享短期失败证据；不把控制锁或未知状态当成地形失败。
            ctx.run.navigationFailures=ctx.run.navigationFailures or {}
            local failures=ctx.run.navigationFailures
            failures[#failures+1]={goal={x=m.goal.x,y=m.goal.y},
                direction={x=(m.goal.x-m.position.x)/length,y=(m.goal.y-m.position.y)/length},
                frame=fight.Frame,reason=reason}
            while #failures>20 do table.remove(failures,1) end
            m.failureRecorded=true
        end
    end
    return report(ctx,fight,'failed',reason,extra)
end
local function baseline(m,frame,pos,target)
    m.progress={frame=frame,x=pos.x,y=pos.y,distance=distance(pos,target)}
end
BehaviorTreeCapabilityChecks['fight.navigate']={kind='fight',controllable=true,available=function(fight)
    return BehaviorTreeFight.available(fight)
end}
BehaviorTreeHandlers.fight_navigate=function(ctx)
    local fight=ctx.object(ctx.params.role)
    if not BehaviorTreeFight.available(fight) then return fail(ctx,fight,'movement_capability_lost') end
    local m,p=ctx.memory,ctx.params
    m.started=m.started or ctx.now
    if ctx.now-m.started>=(p.timeout or 5) then return fail(ctx,fight,'timeout') end
    local mapKnown,is3d=pcall(function() return fight.Scene.ActiveTerrain.ThreeDMap end)
    if not mapKnown or type(is3d)~='boolean' then return fail(ctx,fight,'map_unknown') end
    if is3d then return fail(ctx,fight,'map_3d_unsupported') end
    local navKnown,nav=pcall(function() return fight.Scene.NavMesh end)
    if not navKnown or not nav then return fail(ctx,fight,'navmesh_unknown') end
    local player=fight:GetClientRole().Npc
    local pos=point(player.Position)
    if not pos then return fail(ctx,fight,'position_unknown') end
    m.position=pos
    local frame=fight.Frame
    if not m.goal or (p.trackGoal and m.goalReadFrame~=frame) then
        local candidate=goalFrom(ctx)
        if not candidate then return fail(ctx,fight,'goal_invalid') end
        m.goalReadFrame=frame
        local dot
        if m.goal then
            local oldLength,newLength=distance(pos,m.goal),distance(pos,candidate)
            if oldLength>(p.arrivalTolerance or 0.35) and newLength>(p.arrivalTolerance or 0.35) then
                dot=((m.goal.x-pos.x)*(candidate.x-pos.x)+(m.goal.y-pos.y)*(candidate.y-pos.y))/(oldLength*newLength)
            end
        end
        local shifted=m.goal and distance(m.goal,candidate)>=(p.goalChangeDistance or 0.75)
        local turned=dot and dot<0.5
        if not m.goal or ((shifted or turned) and ((dot and dot<0) or frame-m.goalChangedFrame>=2)) then
            -- 防御候选可改向；普通微动不重算，反向危险不等待节流。
            release(ctx)
            m.goal,m.goalChangedFrame=candidate,frame
            m.points,m.index,m.progress,m.retryAfterFrame,m.pathFrame,m.source=nil,nil,nil,nil,nil,nil
        end
    end
    if distance(pos,m.goal)>40 then return fail(ctx,fight,'path_limit') end
    ctx.run.combat=ctx.run.combat or {}
    local combat=ctx.run.combat
    combat.navigationFailures=combat.navigationFailures or {}
    local rejected=combat.navigationFailures[p]
    if rejected and frame>=rejected.untilFrame then combat.navigationFailures[p]=nil;rejected=nil end
    if rejected and distance(pos,rejected.position)<(p.minProgress or 0.15)
        and distance(m.goal,rejected.goal)<=(p.arrivalTolerance or 0.35) then
        return fail(ctx,fight,'blocked_retry',{retryAfterFrame=rejected.untilFrame})
    end
    local checked,clear,terrainReason
    -- 到达也必须单独核实当前格和目标格，不沿未经规划的直线判移动成功。
    if distance(pos,m.goal)<=(p.arrivalTolerance or 0.35) then
        checked,clear,terrainReason=pcall(segment,nav,pos,m.goal)
        if not checked then return fail(ctx,fight,'terrain_unknown') end
        if not clear then return fail(ctx,fight,terrainReason) end
        release(ctx)
        return report(ctx,fight,'arrived')
    end
    local controlKnown,canMove=pcall(function()
        if player.IsCaught or (player.CurrentAction==CS.XNpcAction.BeHit and not player.BeHitFSM:CanControl()) then return false end
        if player.Role and player.Role.IgnoreMoveOperation then return false end
        return player:CanMove()
    end)
    if not controlKnown or type(canMove)~='boolean' then return fail(ctx,fight,'control_unknown') end
    if not canMove then
        release(ctx);m.progress=nil;m.lastFrame=frame
        return report(ctx,fight,'paused','action_locked',{canMoveKnown=true,canMove=false})
    end
    local inputKnown,touch,inputEnabled=pcall(function()
        local device=fight.InputSystem:GetDevice(typeof(CS.XInputTouch))
        return device,device and device.Disable==false and fight.InputControl.MoveOpState==true
    end)
    if not inputKnown or not touch or not inputEnabled then return fail(ctx,fight,'input_unavailable') end
    if m.lastFrame and frame<m.lastFrame then return fail(ctx,fight,'frame_rewound') end
    if m.retryAfterFrame and frame<m.retryAfterFrame then
        return report(ctx,fight,'paused','replan_wait',{retryAfterFrame=m.retryAfterFrame,canMoveKnown=true,canMove=true})
    end
    local function plan()
        local ok,points,reason,source=pcall(route,fight,pos,m.goal)
        if not ok then return false,'path_query_unknown' end
        m.source=source
        if not points then return false,reason end
        m.points,m.index,m.pathFrame,m.retryAfterFrame=points,1,frame,nil
        baseline(m,frame,pos,points[1])
        return true
    end
    if not m.points then
        local ok,reason=plan()
        if not ok then return fail(ctx,fight,reason) end
    end
    local tolerance=p.arrivalTolerance or 0.35
    local changed=false
    while m.index<#m.points and distance(pos,m.points[m.index])<=tolerance do
        m.index=m.index+1;changed=true
    end
    local target=m.points[m.index]
    if changed or not m.progress then baseline(m,frame,pos,target) end
    local valid,reason
    checked,valid,reason=pcall(segment,nav,pos,target)
    if not checked then return fail(ctx,fight,'terrain_unknown') end
    local b=m.progress
    local moved=distance(pos,b)
    local advance=b.distance-distance(pos,target)
    local stalled=frame-b.frame>=(p.stuckFrames or 10)
    if not valid or (stalled and (moved<(p.minProgress or 0.15) or advance<(p.minProgress or 0.15))) then
        local cause=not valid and reason or moved<(p.minProgress or 0.15) and 'no_displacement' or 'no_waypoint_advance'
        release(ctx)
        m.replans=m.replans or 0
        if m.replans>=(p.maxReplans or 2) then
            -- 同一节点原地重入不立即顶同一个目标；目标或实际位置改变后可另选路线。
            combat.navigationFailures[p]={position=pos,goal=m.goal,
                untilFrame=frame+(p.replanIntervalFrames or 20)}
            return fail(ctx,fight,'replan_limit',{cause=cause,displacement=moved,advance=advance})
        end
        m.replans=m.replans+1;m.points=nil;m.progress=nil
        m.retryAfterFrame=math.max(frame+1,(m.pathFrame or frame)+(p.replanIntervalFrames or 20))
        m.lastFrame=frame
        return report(ctx,fight,'paused',cause,{displacement=moved,advance=advance,retryAfterFrame=m.retryAfterFrame})
    end
    if moved>=(p.minProgress or 0.15) and advance>=(p.minProgress or 0.15) then baseline(m,frame,pos,target) end
    local dx,dy=target.x-pos.x,target.y-pos.y
    local length=math.sqrt(dx*dx+dy*dy)
    local cameraKnown,angle=pcall(function() return BehaviorTreeFight.number(CS.XRLManager.Camera:GetEulerY()) end)
    if not cameraKnown or not finite(angle) then return fail(ctx,fight,'camera_unknown') end
    local rad=math.rad(angle)
    dx,dy=dx/length,dy/length
    if m.touch~=touch then release(ctx);m.touch=touch end
    m.cleanup=m.cleanup or function() touch:SetMoveVec(CS.UnityEngine.Vector2.zero,0) end
    touch:SetMoveVec(CS.UnityEngine.Vector2(dx*math.cos(rad)-dy*math.sin(rad),dx*math.sin(rad)+dy*math.cos(rad)),1)
    m.lastFrame=frame
    return report(ctx,fight,'moving',nil,{canMoveKnown=true,canMove=true,
        progressFrames=frame-m.progress.frame,displacement=moved,advance=advance})
end
end

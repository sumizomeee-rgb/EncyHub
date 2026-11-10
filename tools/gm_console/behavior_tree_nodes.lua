-- 业务节点只调用已经存在的游戏接口；不接受树数据中的代码。
local BehaviorTreeHandlers = {}
local BehaviorTreeCapabilityChecks = {}
BehaviorTreeHandlers.wait = function(ctx)
    ctx.memory.started=ctx.memory.started or ctx.now
    return ctx.now-ctx.memory.started >= ctx.params.seconds and 'succeeded' or 'running'
end
BehaviorTreeHandlers.blackboard_set = function(ctx)
    ctx.write(ctx.params.key,ctx.params.value)
    return 'succeeded'
end
local function equalValue(a,b)
    if BehaviorTreeJson then
        if a==BehaviorTreeJson.null or b==BehaviorTreeJson.null then return a==b end
        if type(a)=='table' and type(b)=='table' then
            local function shape(value)
                local mark=getmetatable(value)
                if mark==BehaviorTreeJson.array or mark==BehaviorTreeJson.object then return mark end
                return value[1]~=nil and BehaviorTreeJson.array or BehaviorTreeJson.object
            end
            if shape(a)~=shape(b) then return false end
        end
    end
    if type(a)~=type(b) then return false end
    if type(a)~='table' then return a==b end
    for key,value in pairs(a) do if not equalValue(value,b[key]) then return false end end
    for key in pairs(b) do if a[key]==nil then return false end end
    return true
end
BehaviorTreeHandlers.blackboard_equals = function(ctx)
    return equalValue(ctx.run.blackboard[ctx.params.key],ctx.params.value) and 'succeeded' or 'failed'
end
BehaviorTreeHandlers.unknown = function() return 'awaiting_decision' end
BehaviorTreeHandlers.gameobject_read = function(ctx)
    local go=ctx.object(ctx.params.role)
    local pos=go.transform.position
    ctx.write(ctx.params.output,{name=tostring(go.name),active=go.activeSelf,x=pos.x,y=pos.y,z=pos.z})
    return 'succeeded'
end
BehaviorTreeHandlers.gameobject_offset = function(ctx)
    local go=ctx.object(ctx.params.role)
    if not ctx.memory.started then
        local original=go.transform.localPosition
        local target=CS.UnityEngine.Vector3(original.x+ctx.params.x,original.y+ctx.params.y,original.z+ctx.params.z)
        ctx.memory.cleanup=function()
            local ok, alive = pcall(function() return not go:Equals(nil) end)
            if not ok then error('object_validity_unknown') end
            if ok and alive then go.transform.localPosition=original end
        end
        ctx.memory.started=ctx.now
        go.transform.localPosition=target
    end
    if ctx.now-ctx.memory.started >= ctx.params.seconds then
        if ctx.memory.cleanup then
            local cleanup=ctx.memory.cleanup
            ctx.memory.cleanup=nil
            cleanup()
        end
        return 'succeeded'
    end
    return 'running'
end
BehaviorTreeHandlers.fight_read = function(ctx)
    local fight=ctx.object(ctx.params.role)
    local player=fight:GetClientRole()
    local npc=player and player.Npc
    if not npc or npc.IsDeleted then return 'failed' end
    ctx.write(ctx.params.output,{npcId=npc.Id,life=npc.Attrib[CS.System.Convert.ToInt32(CS.XNpcAttribType.Life)].Value,energy=npc.Attrib[CS.System.Convert.ToInt32(CS.XNpcAttribType.Energy)].Value,isDead=npc.IsDead,position=tostring(npc.Position),frame=fight.Frame,action=tostring(npc.CurrentAction)})
    return 'succeeded'
end

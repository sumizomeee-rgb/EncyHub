-- 单一游戏内运行器，节点实现由注入器显式装载。
local function CreateBehaviorTree(host, definitions, handlers)
    local bt = {runtimeBuild='ency-bt-20261111-r26', sessionId = tostring(host.now()) .. ':' .. tostring({}), trees = {}, runs = {}, objects = {}, replies = {}, replyOrder = {}}
    local registry = {}
    local treeOrder, runOrder, objectOrder = {}, {}, {}
    local objectGeneration, lastObjectSweep = 0, -math.huge
    local function removeOrder(order,id)
        for i,value in ipairs(order) do if value==id then table.remove(order,i); return end end
    end
    local function objectBound(id)
        for _,run in pairs(bt.runs) do
            if run.state=='running' or run.state=='awaiting_decision' then
                for _,token in pairs(run.bindings) do if token.id==id then return true end end
            end
        end
        return false
    end
    local function sweepObjects()
        local currentScene, now = host.scene(), host.now()
        local checkValidity=now-lastObjectSweep>=1
        for i=#objectOrder,1,-1 do
            local id=objectOrder[i]; local obj=bt.objects[id]
            local ok,valid=true,true
            if checkValidity and obj then ok,valid=pcall(obj.valid) end
            if not obj or obj.token.scene~=currentScene or not ok or not valid then
                bt.objects[id]=nil; table.remove(objectOrder,i)
            end
        end
        if checkValidity then lastObjectSweep=now end
    end
    for _, def in ipairs(definitions) do registry[def.id] = def end
    local function copyValue(value, seen, depth)
        if BehaviorTreeJson and value==BehaviorTreeJson.null then return value end
        depth=depth or 0
        if depth>64 then error('value_depth') end
        local kind=type(value)
        if kind=='table' then
            seen=seen or {}
            if seen[value] then error('value_cycle') end
            seen[value]=true
            local result={}
            if BehaviorTreeJson then
                local shape=getmetatable(value)
                if shape==BehaviorTreeJson.array or shape==BehaviorTreeJson.object then setmetatable(result,shape) end
            end
            for key,item in pairs(value) do
                if type(key)~='string' and (type(key)~='number' or key%1~=0) then error('value_key') end
                result[key]=copyValue(item,seen,depth+1)
            end
            seen[value]=nil
            return result
        end
        if kind=='number' and (value~=value or value==math.huge or value==-math.huge) then error('non_finite_value') end
        if kind~='nil' and kind~='boolean' and kind~='string' and kind~='number' then error('blackboard_requires_pure_value') end
        return value
    end
    local function scene() return host.scene() end
    local function snapshot(run, includeTree, options)
        local value={runId=run.id, treeId=run.tree.id, startedAt=run.startedAt, runMode=run.runMode, state=run.state, reason=run.reason, revision=run.revision, eventSeq=run.seq, clock='unity-update', sessionId=run.sessionId}
        -- 发现活跃运行只需目录；完整诊断由查看端按需读取，旧调用仍返回完整状态。
        if not (options and options.summary) then
            value.tree=includeTree and copyValue(run.tree) or nil
            value.nodes=run.states; value.cleanupErrors=run.cleanupErrors
            value.droppedEvents=run.droppedEvents or 0
            if not options or options.includeEvents~=false then value.events=run.events end
            if not options or options.includeBlackboard~=false then value.blackboard=run.blackboard end
        end
        return value
    end
    local function event(run, name, data)
        run.seq = run.seq + 1
        local e = {type='BT_EVENT',sessionId=run.sessionId,runId=run.id,seq=run.seq,event=name,data=data}
        run.events[#run.events+1] = e
        if #run.events > 128 then table.remove(run.events,1); run.droppedEvents=(run.droppedEvents or 0)+1 end
        -- 节点轨迹随 status 读取，状态变化推送，避免逐节点阻塞发送。
        if name=='state' then host.send(e) end
    end
    local function cancel(run, id)
        local n = run.index[id]
        for _, child in ipairs(n.children or {}) do cancel(run,child) end
        local state = run.memory[id]
        if state and state.cleanup then
            local fn = state.cleanup
            state.cleanup = nil
            local ok, err = pcall(fn)
            if not ok then run.cleanupErrors[#run.cleanupErrors+1] = tostring(err) end
        end
        run.memory[id] = nil
        if run.states[id] == 'running' then run.states[id] = 'cancelled' end
    end
    local function finish(run, state, reason)
        if run.state ~= 'running' and run.state ~= 'awaiting_decision' then return end
        run.state = state
        run.reason = reason
        cancel(run,run.tree.root)
        if #run.cleanupErrors > 0 then run.state='error'; run.reason='cleanup_failed' end
        if run.state~='awaiting_decision' then
            -- 终态只保留纯值诊断；业务缓存可能含 NPC、Skill 或清理闭包。
            local retained={id=true,startedAt=true,runMode=true,sessionId=true,tree=true,
                blackboard=true,revision=true,states=true,events=true,seq=true,state=true,
                reason=true,cleanupErrors=true,droppedEvents=true,memory=true}
            for key in pairs(run) do if not retained[key] then run[key]=nil end end
            run.memory={}
        end
        event(run,'state',{state=run.state,reason=run.reason,cleanupErrors=run.cleanupErrors})
    end
    function bt.stopAll(reason)
        for _, run in pairs(bt.runs) do finish(run,'stopped',reason) end
        bt.objects = {}
        objectOrder = {}
        bt.sessionId = tostring(host.now()) .. ':' .. tostring({})
        bt.replies = {}; bt.replyOrder = {}
    end
    function bt.validate(tree, bindings)
        local errors, index = {}, {}
        local function container(value,shape)
            if type(value)~='table' then return false end
            if not BehaviorTreeJson then return true end
            local mark=getmetatable(value)
            return value~=BehaviorTreeJson.null and (mark==nil or mark==BehaviorTreeJson[shape])
        end
        local function bad(path,msg) errors[#errors+1]={path=path,message=msg} end
        if type(tree)~='table' or tree.schemaVersion~=1 or type(tree.id)~='string' or not container(tree.nodes,'array') then
            return {ok=false,errors={{path='tree',message='invalid_schema'}}}
        end
        if (tree.roles~=nil and not container(tree.roles,'object')) or (tree.blackboard~=nil and not container(tree.blackboard,'object')) then
            return {ok=false,errors={{path='tree',message='invalid_roles_or_blackboard'}}}
        end
        for key,role in pairs(tree.roles or {}) do if type(key)~='string' or not container(role,'object') then return {ok=false,errors={{path='roles',message='invalid_role'}}} end end
        local pure, reason=pcall(copyValue,tree.blackboard or {})
        if not pure then bad('blackboard',tostring(reason)) end
        if #tree.nodes==0 or #tree.nodes>256 then bad('nodes','node_limit') end
        for i,n in ipairs(tree.nodes) do
            local path='nodes['..i..']'
            if not container(n,'object') or type(n.type)~='string' or (n.params~=nil and not container(n.params,'object')) or (n.children~=nil and not container(n.children,'array')) then
                return {ok=false,errors={{path=path,message='invalid_node_shape'}}}
            end
            for _,child in ipairs(n.children or {}) do if type(child)~='string' then
                return {ok=false,errors={{path=path..'.children',message='invalid_child_id'}}}
            end end
            local pure, reason=pcall(copyValue,n.params or {})
            if not pure then return {ok=false,errors={{path=path..'.params',message=tostring(reason)}}} end
            if type(n.id)~='string' or n.id=='' or index[n.id] then bad(path,'duplicate_or_invalid_id') else index[n.id]=n end
            local def=registry[n.type]
            if not def or n.version~=def.version then bad(path,'unknown_node_or_version') else
                local children=n.children or {}
                if n.type=='parallel' then
                    for _,key in ipairs({'successThreshold','failureThreshold'}) do
                        local threshold=(n.params or {})[key]
                        if type(threshold)=='number' and threshold>#children then bad(path..'.params.'..key,'threshold_exceeds_children') end
                    end
                end
                if #children < def.minChildren or #children > def.maxChildren then bad(path..'.children','child_count') end
                local p=n.params or {}
                for key,s in pairs(def.params.properties or {}) do
                    local v=p[key]
                    if v~=nil then
                        local valid=(s.type=='number' and type(v)=='number') or (s.type=='integer' and type(v)=='number' and v%1==0) or (s.type=='string' and type(v)=='string') or (s.type=='boolean' and type(v)=='boolean') or s.type==nil
                        if not valid then bad(path..'.params.'..key,'parameter_type') end
                        if type(v)=='number' and ((s.minimum and v<s.minimum) or (s.maximum and v>s.maximum)) then bad(path..'.params.'..key,'parameter_range') end
                        if s.enum then local found=false; for _,x in ipairs(s.enum) do if x==v then found=true end end; if not found then bad(path..'.params.'..key,'parameter_enum') end end
                    end
                end
                for _,key in ipairs(def.params.required or {}) do if p[key]==nil then bad(path..'.params.'..key,'required') end end
                for key in pairs(p) do if not def.params.properties[key] then bad(path..'.params.'..key,'unknown_parameter') end end
                for _,role in ipairs(def.roles or {}) do local key=p[role.parameter]; if not key or not (tree.roles or {})[key] or type(tree.roles[key])~='table' or tree.roles[key].kind~=role.kind then bad(path,'role_kind') end end
            end
        end
        local visited, active = {}, {}
        local function walk(id,depth)
            if not index[id] then bad('children','missing_node'); return end
            if active[id] or depth>64 then bad('children','cycle_or_depth'); return end
            if visited[id] then bad('children','multiple_parents'); return end
            active[id]=true; visited[id]=true
            for _,child in ipairs(index[id].children or {}) do walk(child,depth+1) end
            active[id]=nil
        end
        walk(tree.root,1)
        for id in pairs(index) do if not visited[id] then bad(id,'unreachable') end end
        if #errors==0 then
            local function resources(id)
                local n=index[id]; local def=registry[n.type]; local result={}
                for _,resource in ipairs(def.resources or {}) do
                    local value=(n.params or {})[resource.parameter]
                    -- 不同槽可能绑定同一个对象；启动时按已核验的对象身份复核。
                    if bindings and resource.kind=='object' then value=bindings[value].id end
                    result[resource.kind..':'..tostring(value)]=true
                end
                for _,child in ipairs(n.children or {}) do for key in pairs(resources(child)) do result[key]=true end end
                return result
            end
            for id,n in pairs(index) do if n.type=='parallel' then
                local used={}
                for _,child in ipairs(n.children or {}) do for key in pairs(resources(child)) do
                    if used[key] then bad(id,'parallel_resource_conflict') end
                    used[key]=true
                end end
            end end
        end
        return {ok=#errors==0,errors=errors}
    end
    local tick
    tick=function(run,id)
        run.budget=run.budget-1
        if run.budget<0 then error('tick_budget') end
        local n=run.index[id]
        local entering=run.memory[id]==nil
        if entering then event(run,'node',{nodeId=id,phase='enter'}) end
        local m=run.memory[id] or {}; run.memory[id]=m
        local p=n.params or {}; local children=n.children or {}; local kind=n.type
        local state
        if kind=='sequence' or kind=='selector' then
            local sequence=kind=='sequence'
            local start=p.reactive and 1 or (m.cursor or 1)
            state=sequence and 'succeeded' or 'failed'
            for i=start,#children do
                local previous=run.beforeAction
                if p.reactive and m.cursor and m.cursor~=i then
                    run.beforeAction=function()
                        cancel(run,children[m.cursor])
                        if #run.cleanupErrors>0 then error('preemption_cleanup_failed') end
                        if previous then previous() end
                    end
                end
                local s=tick(run,children[i])
                run.beforeAction=previous
                if s=='running' or s=='awaiting_decision' or (sequence and s=='failed') or (not sequence and s=='succeeded') then
                    if m.cursor and m.cursor~=i then cancel(run,children[m.cursor]) end
                    m.cursor=i; state=s; break
                end
            end
        elseif kind=='parallel' then
            local success,failed=0,0
            m.results=m.results or {}
            for _,child in ipairs(children) do
                local s=m.results[child]
                if s~='succeeded' and s~='failed' then s=tick(run,child) end
                m.results[child]=s
                if s=='awaiting_decision' then state=s; break end
                if s=='succeeded' then success=success+1 elseif s=='failed' then failed=failed+1 end
            end
            state=state or ((success>=(p.successThreshold or #children)) and 'succeeded' or (failed>=(p.failureThreshold or 1) and 'failed' or 'running'))
            if state~='running' then
                for _,child in ipairs(children) do if m.results[child]=='running' then cancel(run,child) end end
            end
        elseif kind=='repeat' then
            local s=tick(run,children[1])
            if s=='succeeded' then
                m.count=(m.count or 0)+1
                cancel(run,children[1])
                state=m.count>=p.count and 'succeeded' or 'running'
            else state=s end
        elseif kind=='timeout' then
            m.started=m.started or host.now()
            if host.now()-m.started>=p.seconds then cancel(run,children[1]); state='failed' else state=tick(run,children[1]) end
        elseif kind=='invert' then
            local s=tick(run,children[1]); state=s=='succeeded' and 'failed' or (s=='failed' and 'succeeded' or s)
        else
            local context={run=run, memory=m, params=p, now=host.now(), host=host}
            function context.object(role)
                local token=run.bindings[role]
                local obj=token and bt.objects[token.id]
                if not obj or token.sessionId~=bt.sessionId or token.scene~=scene() or token.generation~=obj.token.generation or not obj.valid() then error('object_invalid:'..tostring(role)) end
                return obj.value
            end
            function context.write(key,value)
                run.blackboard[key]=copyValue(value); run.revision=run.revision+1
            end
            if registry[kind].sideEffect~='none' and run.beforeAction then run.beforeAction() end
            state=handlers[kind](context)
        end
        if state~='running' and state~='succeeded' and state~='failed' and state~='awaiting_decision' then error('invalid_node_result:'..id) end
        if entering or run.states[id]~=state then run.states[id]=state; event(run,'node',{nodeId=id,state=state,phase=state=='running' and 'running' or 'exit'}) end
        return state
    end
    function bt.update()
        for _,run in pairs(bt.runs) do
            if run.state=='running' or run.state=='awaiting_decision' then
                if run.scene~=scene() then finish(run,'stopped','scene_changed')
                else
                    local valid=true
                    for _,token in pairs(run.bindings) do
                        local obj=bt.objects[token.id]
                        if not obj or token.sessionId~=bt.sessionId or token.scene~=scene() or token.generation~=obj.token.generation or not obj.valid() then valid=false end
                    end
                    if not valid then finish(run,'stopped','object_destroyed') elseif run.state=='running' then
                        run.budget=512
                        local ok,result=pcall(tick,run,run.tree.root)
                        if not ok then finish(run,'error',tostring(result))
                        elseif result~='running' then finish(run,result,result=='awaiting_decision' and 'unknown_state' or nil) end
                    end
                end
            end
        end
        sweepObjects()
    end
    function bt.registerObject(id,kind,name,value,valid,capabilities)
        local old=bt.objects[id]
        if old and old.value==value and old.token.scene==scene() and old.valid() then
            old.capabilities=capabilities or {}
            return old.token
        end
        -- 淘汰后重新发现也不能复用旧令牌的代次。
        objectGeneration=objectGeneration+1
        local token={sessionId=bt.sessionId,scene=scene(),kind=kind,id=id,generation=objectGeneration}
        removeOrder(objectOrder,id); objectOrder[#objectOrder+1]=id
        bt.objects[id]={token=token,value=value,valid=valid,name=name,capabilities=capabilities or {}}
        if #objectOrder>256 then
            for i,key in ipairs(objectOrder) do if not objectBound(key) then
                bt.objects[key]=nil; table.remove(objectOrder,i); break
            end end
        end
        return token
    end
    function bt.handle(req)
        if req.sessionId and req.sessionId~=bt.sessionId then
            host.send({type='BT_RESPONSE',protocolVersion=1,requestId=req.requestId,sessionId=bt.sessionId,ok=false,error={code='stale_session',message='stale_session'}})
            return
        end
        local cached=bt.replies[req.requestId]
        if cached then host.send(cached); return end
        local ok,data=pcall(function()
            if req.protocolVersion~=1 or type(req.requestId)~='string' then error('invalid_request') end
            local p=req.payload or {}; local action=req.action
            if action=='capabilities' then return {nodes=definitions,sessionId=bt.sessionId,clock='unity-update',runtimeBuild=bt.runtimeBuild,runModes={'autonomous'},executionLifetime='tree'}
            elseif action=='discover' then return {objects=host.discover(bt,p),sessionId=bt.sessionId}
            elseif action=='validate' then return bt.validate(p.tree)
            elseif action=='install' then
                local result=bt.validate(p.tree); if not result.ok then return result end
                bt.trees[p.tree.id]=p.tree
                removeOrder(treeOrder,p.tree.id); treeOrder[#treeOrder+1]=p.tree.id
                if #treeOrder>32 then bt.trees[table.remove(treeOrder,1)]=nil end
                return {ok=true,treeId=p.tree.id}
            elseif action=='start' then
                local tree=bt.trees[p.treeId]; if not tree then error('tree_not_installed') end
                local runId=p.runId or req.requestId
                if bt.runs[runId] then return snapshot(bt.runs[runId]) end
                for _,run in pairs(bt.runs) do if run.state=='running' or run.state=='awaiting_decision' then error('run_already_active') end end
                local bindings=p.bindings or {}
                for role,requirement in pairs(tree.roles or {}) do
                    local token=bindings[role]; local obj=token and bt.objects[token.id]
                    if not obj or token.kind~=requirement.kind or token.sessionId~=bt.sessionId or token.scene~=scene() or token.generation~=obj.token.generation or not obj.valid() then error('binding_invalid:'..role) end
                end
                for _,node in ipairs(tree.nodes) do for _,requirement in ipairs(registry[node.type].roles or {}) do
                    local token=bindings[node.params[requirement.parameter]]; local obj=bt.objects[token.id]
                    local found=false; for _,cap in ipairs(obj.capabilities) do if cap==requirement.capability then found=true end end
                    if requirement.capability and not found then error('binding_capability:'..node.id) end
                end end
                local boundValidation=bt.validate(tree,bindings)
                if not boundValidation.ok then error('parallel_resource_conflict:'..boundValidation.errors[1].path) end
                local startedAt=host.now()
                -- 生命周期由树和游戏对象决定，网页只是查看与启停入口。
                local run={id=runId,startedAt=startedAt,runMode='autonomous',sessionId=bt.sessionId,tree=tree,index={},bindings=bindings,blackboard={},revision=0,states={},memory={},events={},seq=0,state='running',cleanupErrors={},scene=scene()}
                run.blackboard=copyValue(tree.blackboard or {})
                for _,n in ipairs(tree.nodes) do run.index[n.id]=n end
                -- 历史运行有界，当前运行不被淘汰。
                if #runOrder>=32 then
                    for i,id in ipairs(runOrder) do
                        local r=bt.runs[id]
                        if r.state~='running' and r.state~='awaiting_decision' then
                            bt.runs[id]=nil; table.remove(runOrder,i); break
                        end
                    end
                end
                runOrder[#runOrder+1]=runId
                bt.runs[runId]=run; event(run,'state',{state=run.state}); return snapshot(run)
            elseif action=='stop' or action=='status' then
                local results={}
                for id,run in pairs(bt.runs) do if not p.runId or id==p.runId then
                    if action=='stop' then finish(run,'stopped','user_stop') end
                    results[#results+1]=snapshot(run,p.includeTree,p)
                end end
                return {runs=results,sessionId=bt.sessionId}
            end
            error('unknown_action')
        end)
        local reply={type='BT_RESPONSE',protocolVersion=1,requestId=req.requestId,sessionId=bt.sessionId,ok=ok,data=ok and data or nil,error=not ok and {code='runtime_error',message=tostring(data)} or nil}
        -- 只为变更操作保存幂等回执，轮询不应保留旧黑板快照。
        if req.requestId and (req.action=='install' or req.action=='start' or req.action=='stop') then
            bt.replies[req.requestId]=reply; bt.replyOrder[#bt.replyOrder+1]=req.requestId
        end
        if #bt.replyOrder>128 then bt.replies[table.remove(bt.replyOrder,1)]=nil end
        host.send(reply)
    end
    return bt
end

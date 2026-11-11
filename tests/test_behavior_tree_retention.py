"""离线运行真实 Lua 内核，验证终态只保留诊断且不抓住游戏对象。"""
import pytest

from test_behavior_tree_runtime import vm, tree, node, install_start


@pytest.mark.parametrize('ending', ['success', 'error', 'stop', 'scene', 'destroy'])
def test_terminal_releases_userdata_and_business_closures(vm, ending):
    lua, convert = vm
    lua.globals().ending = ending
    lua.execute('''
        alive=true
        token=bt.registerObject('x','gameobject','probe',{},function() return alive end,{})
        weak=setmetatable({},{__mode='v'})
        BehaviorTreeHandlersExport.blackboard_set=function(ctx)
            local skill=io.tmpfile();skill:close()
            weak[1]=skill
            ctx.run.combat={playerSkill=skill,target=skill}
            ctx.run.futureBusinessCache={object=skill}
            ctx.run.beforeAction=function() return skill end
            ctx.memory.cleanup=function() cleaned=cleaned+1;return skill end
            ctx.write('result',{phase='observed',value=0})
            if ending=='error' then error('injected_failure') end
            return ending=='success' and 'succeeded' or 'running'
        end
    ''')
    data = tree([node('root', 'blackboard_set', {'key': 'result', 'value': 0})],
                roles={'target': {'kind': 'gameobject'}})
    assert install_start(vm, data, {'target': lua.globals().token})['ok']
    lua.execute('bt.update()')
    if ending == 'stop':
        lua.execute("request('stop','stop',{})")
    elif ending == 'scene':
        lua.execute("currentScene='two';bt.update()")
    elif ending == 'destroy':
        lua.execute('alive=false;bt.update()')
    lua.execute('''
        local run=bt.runs.start
        assert(run.state~='running' and cleaned==1)
        assert(run.combat==nil and run.futureBusinessCache==nil and run.beforeAction==nil)
        assert(run.index==nil and run.bindings==nil and next(run.memory)==nil)
        collectgarbage('collect');collectgarbage('collect')
        assert(weak[1]==nil,'terminal run still retains userdata')
    ''')
    snapshot = lua.globals().request('view', 'status', convert({'includeTree': True}))['data']['runs'][1]
    assert snapshot['tree']['root'] == 'root'
    assert snapshot['blackboard']['result']['phase'] == 'observed'
    assert snapshot['blackboard']['result']['value'] == 0
    assert len(snapshot['events']) > 0


def test_status_polling_does_not_cache_replaced_blackboards(vm):
    lua, convert = vm
    assert install_start(vm, tree([node('root', 'wait', {'seconds': 100})]))['ok']
    lua.execute('''
        weak=setmetatable({},{__mode='v'})
        for i=1,200 do
            local observation={frame=i}
            bt.runs.start.blackboard={observation=observation}
            weak[i]=observation
            request('poll'..i,'status',{})
        end
        packets={}
        collectgarbage('collect');collectgarbage('collect')
        assert(weak[1]==nil and weak[199]==nil and weak[200].frame==200)
        assert(#bt.replyOrder==2 and bt.replies.poll200==nil)
        assert(request('start','start',{treeId='test'}).data.runId=='start')
    ''')


def test_object_registry_releases_invalid_objects_and_keeps_generations_unique(vm):
    lua, _ = vm
    lua.execute('''
        weak=setmetatable({},{__mode='v'})
        do
            local npc=io.tmpfile();npc:close();weak[1]=npc
            old=bt.registerObject('npc','fight','old',npc,function() return false,npc end,{})
        end
        bt.update()
        collectgarbage('collect');collectgarbage('collect')
        assert(bt.objects.npc==nil and weak[1]==nil)
        local fresh=bt.registerObject('npc','fight','new',{},function() return true end,{})
        assert(fresh.generation>old.generation)
        for i=1,300 do bt.registerObject('go'..i,'gameobject','probe',{},function() return true end,{}) end
        local count=0;for _ in pairs(bt.objects) do count=count+1 end
        assert(count==256 and bt.objects.npc==nil and bt.objects.go1==nil and bt.objects.go300)
        currentScene='other';bt.update()
        assert(next(bt.objects)==nil)
    ''')


def test_discovery_limit_preserves_an_active_binding(vm):
    lua, _ = vm
    lua.execute('''
        token=bt.registerObject('bound','gameobject','active',{},function() return true end,{})
    ''')
    assert install_start(vm, tree([node('root', 'wait', {'seconds': 100})],
                                 roles={'target': {'kind': 'gameobject'}}),
                         {'target': lua.globals().token})['ok']
    lua.execute('''
        for i=1,300 do bt.registerObject('go'..i,'gameobject','probe',{},function() return true end,{}) end
        bt.update()
        assert(bt.objects.bound and bt.runs.start.state=='running')
    ''')


def test_installed_trees_and_terminal_history_evict_oldest(vm):
    lua, _ = vm
    lua.execute('''
        for i=1,40 do
            local tree={schemaVersion=1,id='tree'..i,root='root',roles={},blackboard={},
                nodes={{id='root',type='wait',version=1,params={seconds=1},children={}}}}
            assert(request('install'..i,'install',{tree=tree}).data.ok)
            assert(request('start'..i,'start',{treeId=tree.id}).ok)
            assert(request('stop'..i,'stop',{runId='start'..i}).ok)
        end
        local trees,runs=0,0
        for _ in pairs(bt.trees) do trees=trees+1 end
        for _ in pairs(bt.runs) do runs=runs+1 end
        assert(trees==32 and runs==32)
        assert(bt.trees.tree8==nil and bt.trees.tree9 and bt.trees.tree40)
        assert(bt.runs.start8==nil and bt.runs.start9 and bt.runs.start40)
        local response=request('last','status',{runId='start40',includeTree=true})
        assert(response.data.runs[1].tree.id=='tree40' and response.data.runs[1].state=='stopped')
    ''')

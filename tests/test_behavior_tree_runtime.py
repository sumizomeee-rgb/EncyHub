"""执行实际 Lua 内核；替身用于离线校验，不能代替游戏联调。"""
import asyncio
import json
from pathlib import Path
import pytest
from tools.gm_console.behavior_tree import validate_tree, node_catalog
from tools.gm_console.runtime_gm_code import read_runtime_gm_source
from tools.gm_console.server_mgr import ServerMgr, Client

ROOT = Path(__file__).parents[1] / 'tools/gm_console'

def tree(nodes, root='root', roles=None):
    return dict(schemaVersion=1,id='test',root=root,nodes=nodes,roles=roles or {},blackboard={})

def node(id, type, params=None, children=None):
    return dict(id=id,type=type,version=1,params=params or {},children=children or [])

def test_validation_and_generic_resources():
    assert validate_tree(tree([node('root','wait',{'seconds':1})]))['ok']
    assert not validate_tree(tree([node('root','sequence',children=['root'])]))['ok']
    assert not validate_tree(tree([node('root','wait',{'seconds':-1})]))['ok']
    assert not validate_tree(tree([node('root','missing')]))['ok']
    parallel=tree([node('root','parallel',children=['a','b']),node('a','blackboard_set',{'key':'x','value':1}),node('b','blackboard_set',{'key':'x','value':2})])
    assert not validate_tree(parallel)['ok']

@pytest.fixture
def vm():
    lupa=pytest.importorskip('lupa')
    lua=lupa.LuaRuntime(unpack_returned_tuples=True)
    lua.compile(read_runtime_gm_source())
    lua.execute(ROOT.joinpath('behavior_tree_runtime.lua').read_text(encoding='utf8')+'\nCreateBehaviorTreeExport=CreateBehaviorTree')
    def convert(value):
        if isinstance(value, dict): return lua.table_from({k:convert(v) for k,v in value.items()})
        if isinstance(value, list): return lua.table_from([convert(v) for v in value])
        return value
    lua.globals().defs=convert(node_catalog())
    lua.execute(ROOT.joinpath('behavior_tree_nodes.lua').read_text(encoding='utf8')+'\nBehaviorTreeHandlersExport=BehaviorTreeHandlers')
    lua.execute('''
        clock=0; currentScene='one'; packets={}; cleaned=0
        host={now=function() return clock end,scene=function() return currentScene end,
              send=function(p) packets[#packets+1]=p end,discover=function() return {} end}
        BehaviorTreeHandlersExport.gameobject_offset=function(c)
            c.memory.cleanup=c.memory.cleanup or function() cleaned=cleaned+1 end
            return 'running'
        end
        bt=CreateBehaviorTreeExport(host,defs,BehaviorTreeHandlersExport)
        function request(id,action,payload)
            bt.handle({protocolVersion=1,requestId=id,action=action,payload=payload})
            return packets[#packets]
        end
    ''')
    return lua, convert

def install_start(vm, data, bindings=None, **options):
    lua, convert=vm
    request=lua.globals().request
    assert request('install','install',convert({'tree':data}))['data']['ok']
    return request('start','start',convert({'treeId':'test','bindings':bindings or {},**options}))

def test_lua_wait_success_and_duplicate(vm):
    lua,convert=vm
    assert install_start(vm,tree([node('root','wait',{'seconds':1})]))['data']['state']=='running'
    lua.execute('bt.update(); clock=2; bt.update()')
    assert lua.globals().bt.runs['start'].state=='succeeded'
    # 相同请求不产生第二个运行，也不重发节点动作。
    lua.globals().request('start','start',convert({'treeId':'test'}))
    assert len(lua.globals().bt.replyOrder)==2

@pytest.mark.parametrize('cause', ['stop','scene','destroy'])
def test_lua_owned_cleanup_once(vm,cause):
    lua,convert=vm
    lua.execute("alive=true; value={}; token=bt.registerObject('x','gameobject','probe',value,function() return alive end,{'gameobject.transform.debug'})")
    data=tree([node('root','gameobject_offset',dict(role='target',x=1,y=0,z=0,seconds=10))],roles={'target':{'kind':'gameobject'}})
    token=lua.globals().token
    assert install_start(vm,data,{'target':token})['ok']
    lua.execute('bt.update()')
    if cause=='stop':lua.execute("request('stop','stop',{});request('again','stop',{})")
    elif cause=='scene':lua.execute("currentScene='two';bt.update()")
    elif cause=='destroy':lua.execute('alive=false;bt.update()')
    assert lua.globals().bt.runs['start'].state=='stopped'
    assert lua.globals().cleaned==1

def test_lua_unknown_and_invalid_binding(vm):
    lua,convert=vm
    install_start(vm,tree([node('root','unknown')]))
    lua.execute('bt.update()')
    assert lua.globals().bt.runs['start'].state=='awaiting_decision'
    assert not lua.globals().request('bad','start',convert({'treeId':'absent'}))['ok']
    lua.execute("request('stop_unknown','stop',{})")
    assert lua.globals().bt.runs['start'].state=='stopped'

def test_lua_repeat_resets_parallel_children(vm):
    lua,_=vm
    data=tree([node('root','repeat',{'count':2},['parallel']),node('parallel','parallel',children=['a','b']),node('a','blackboard_set',{'key':'a','value':1}),node('b','blackboard_set',{'key':'b','value':2})])
    install_start(vm,data)
    lua.execute('bt.update();bt.update()')
    run=lua.globals().bt.runs['start']
    assert run.state=='succeeded' and run.revision==4

def test_server_waits_for_game_receipt():
    async def check():
        mgr=ServerMgr()
        class Writer:
            def write(self, data):self.packet=json.loads(data)
            async def drain(self):pass
        writer=Writer(); client=Client(id='c',port=1,writer=writer,ip='127.0.0.1');mgr.clients['c']=client
        task=asyncio.create_task(mgr.behavior_tree_request('c','stop',{},'request'))
        await asyncio.sleep(0)
        assert not task.done()
        mgr._process_packet(client,{'type':'BT_RESPONSE','requestId':'wrong','ok':True})
        assert not task.done()
        mgr._process_packet(client,{'type':'BT_RESPONSE','requestId':'request','ok':True,'data':{'state':'stopped'}})
        assert (await task)['data']['state']=='stopped'
        result=await mgr.behavior_tree_request('c','start',{},'timeout',timeout=0.01)
        assert result['state']=='unknown'
    asyncio.run(check())

def test_actual_tcp_receive_reassembles_across_frames():
    lupa=pytest.importorskip('lupa')
    lua=lupa.LuaRuntime(unpack_returned_tuples=True)
    source=ROOT.joinpath('runtime_gm_client.lua').read_text(encoding='utf8')
    start=source.index('        local maxLoops = 5')
    end=source.index('        -- Lua 侧 Animator',start)
    lua.execute('''
        now=1; parsed={}; chunks={}; closed=0
        RuntimeGMClient={Socket={settimeout=function() end,receive=function()
            local c=table.remove(chunks,1)
            if c then return c.line,c.err,c.partial end
            return nil,'timeout',''
        end}, ProcessPacket=function(line) parsed[#parsed+1]=line end,
        Close=function() closed=closed+1 end}
    ''')
    lua.execute('function pump()\n'+source[start:end]+'\nend')
    lua.execute('''
        chunks={{partial='{"type":"BT_',err='timeout'}};pump()
        assert(#parsed==0)
        chunks={{line='REQUEST"}'}};now=2;pump()
        assert(#parsed==1 and parsed[1]=='{"type":"BT_REQUEST"}')
        chunks={{partial=string.rep('x',4*1024*1024+1),err='timeout'}};pump()
        assert(closed==1 and #parsed==1)
    ''')


def test_revision_lifecycle_contract(vm):
    lua, convert = vm
    lua.execute(ROOT.joinpath("behavior_tree_nodes.lua").read_text(encoding="utf8")+"\nBehaviorTreeHandlersExport=BehaviorTreeHandlers")
    lua.globals().BehaviorTreeDefinitions = convert(node_catalog())
    lua.globals().CreateBehaviorTree = lua.globals().CreateBehaviorTreeExport
    lua.globals().BehaviorTreeHandlers = lua.globals().BehaviorTreeHandlersExport
    lua.execute("local originalOffset=BehaviorTreeHandlers.gameobject_offset\nlocal function node(id, kind, params, children)\n    return {id=id,type=kind,version=1,params=params or {},children=children or {}}\nend\nlocal function reset()\n    clock=0; currentScene='one'; sent={}; cleaned=0\n    host={now=function() return clock end,scene=function() return currentScene end,send=function(p) sent[#sent+1]=p end,discover=function() return {} end}\n    bt=CreateBehaviorTree(host,BehaviorTreeDefinitions,BehaviorTreeHandlers)\nend\nlocal function request(id, action, payload, session)\n    bt.handle({protocolVersion=1,requestId=id,sessionId=session,action=action,payload=payload or {}})\n    return sent[#sent]\nend\nlocal function start(nodes, roles, bindings)\n    local tree={schemaVersion=1,id='test',root='root',nodes=nodes,roles=roles or {},blackboard={}}\n    assert(request('install','install',{tree=tree}).data.ok)\n    assert(request('start','start',{treeId='test',bindings=bindings or {}}).ok)\nend\n\nreset()\nlocal value={}\nlocal token=bt.registerObject('x','gameobject','probe',value,function() return true end,{'gameobject.read'})\ncurrentScene='two'\nlocal newer=bt.registerObject('x','gameobject','probe',value,function() return true end,{'gameobject.read'})\nassert(newer.generation==token.generation+1 and newer.scene=='two')\nprint('PASS 同一引用显式发现生成新场景令牌')\n\nreset()\nlocal oldAlive=true\ntoken=bt.registerObject('x','gameobject','probe',value,function() return oldAlive end,{'gameobject.read'})\nstart({node('root','wait',{seconds=10})},{target={kind='gameobject'}},{target=token})\noldAlive=false\nnewer=bt.registerObject('x','gameobject','probe',value,function() return true end,{'gameobject.read'})\nbt.update()\nassert(bt.runs.start.state=='stopped' and newer.generation~=token.generation)\nprint('PASS 对象代次变化在等待节点中也立即停止')\n\nreset()\nBehaviorTreeHandlers.gameobject_offset=function(ctx)\n    ctx.memory.cleanup=ctx.memory.cleanup or function() cleaned=cleaned+1 end\n    return 'running'\nend\ntoken=bt.registerObject('x','gameobject','probe',value,function() return true end,{'gameobject.transform.debug'})\nstart({node('root','sequence',{}, {'p','wait'}),node('p','parallel',{successThreshold=1},{'move','yes'}),node('move','gameobject_offset',{role='target',x=0,y=0,z=0,seconds=10}),node('yes','blackboard_set',{key='yes',value=true}),node('wait','wait',{seconds=10})},{target={kind='gameobject'}},{target=token})\nbt.update()\nassert(bt.runs.start.state=='running' and cleaned==1 and bt.runs.start.states.move=='cancelled')\nprint('PASS 并行结束立即清理未结束分支而非等待根结束')\n\nreset()\nlocal original=bt.sessionId\nrequest('catalog','capabilities')\nbt.stopAll('runtime_unloaded')\nlocal response=request('catalog','capabilities',{},original)\nassert(not response.ok and response.error.code=='stale_session')\nassert(request('catalog','capabilities').data.runtimeBuild=='ency-bt-20261110-r22')\nprint('PASS 旧session不能命中重复请求缓存')\n\nreset()\nstart({node('root','wait',{seconds=10})})\noriginal=bt.sessionId\nbt.stopAll('runtime_unloaded')\nassert(request('status','status').data.runs[1].sessionId==original)\nprint('PASS 运行器重置后的旧运行快照保留原session')\n\nreset()\nCS={System={Convert={ToInt32=function(value)return value end}},XNpcAttribType={Life=0,Energy=1}}\nlocal npc={Id=3,IsDeleted=false,IsDead=false,Attrib={[0]={Value=100},[1]={Value=20}},Position='1,2',CurrentAction='Default'}\nlocal player={Npc=npc}\nlocal fight={Frame=4,GetClientRole=function() return player end}\ntoken=bt.registerObject('fight:3','fight','player',fight,function() return true end,{'fight.read'})\nstart({node('root','fight_read',{role='player',output='state'})},{player={kind='fight'}},{player=token})\nbt.update()\nassert(bt.runs.start.state=='succeeded' and bt.runs.start.blackboard.state.life==100 and bt.runs.start.blackboard.state.npcId==3)\nprint('PASS XRole.Npc及纯值战斗快照')\n\nreset()\nstart({node('root','repeat',{count=200},{'set'}),node('set','blackboard_set',{key='x',value=1})})\nlocal before=#sent\nfor i=1,199 do bt.update() end\nassert(#sent==before and #bt.runs.start.events==128 and bt.runs.start.droppedEvents>0)\nprint('PASS 节点轨迹有界并随status读取，不逐节点发包')\n\nCS={UnityEngine={Vector3=function(x,y,z) return {x=x,y=y,z=z} end}}\nlocal go={transform={localPosition={x=0,y=0,z=0}},Equals=function() error('unavailable') end}\nlocal context={params={role='target',x=1,y=0,z=0,seconds=1},now=0,memory={},object=function() return go end}\nassert(originalOffset(context)=='running')\nassert(not pcall(context.memory.cleanup))\nprint('PASS 无法证明对象有效性时清理报错，不能伪报恢复成功')\n\nreset()\nlocal tree={schemaVersion=1,id='test',root='root',nodes={node('root','wait',{seconds=10})},roles={},blackboard={nested={value=1}}}\nassert(request('install','install',{tree=tree}).data.ok)\nassert(request('first','start',{treeId='test'}).ok)\nbt.runs.first.blackboard.nested.value=2\nrequest('stop','stop')\nassert(request('second','start',{treeId='test'}).ok)\nassert(bt.runs.second.blackboard.nested.value==1 and tree.blackboard.nested.value==1)\nprint('PASS 黑板嵌套纯值按run隔离，不共享预设数据引用')\n")


def test_r3_quality_and_normal_attack():
    lupa=pytest.importorskip("lupa")
    lua=lupa.LuaRuntime(unpack_returned_tuples=True)
    source=read_runtime_gm_source().split("-- 2. RuntimeGMClient")[0]
    lua.execute(source+"CS={System={Convert={ToInt32=function(value)return value end}},XNpcAttribType={Life=0,Energy=1},XFightState={Fight='Fight'},XInputControl={ForceClickForDebug=false},XNpcOperationClickKey={NormalAttackKey=15},XOperationClickType={KeyDown=1,KeyUp=2}}\nlocal npc={IsActivate=true,IsDeleted=false,IsDead=false,SkillGroupComponent={}}\nlocal player={Npc=npc}\nlocal calls={}\nlocal fight={State='Fight',Frame=1,GetClientRole=function() return player end,InputControl={OnClick=function(_,key,click,force) calls[#calls+1]={key,click,force} end}}\nlocal ctx={params={role='player',output='result',timeout=2,expectedSkillId=101},memory={},now=0,object=function() return fight end,write=function(_,value) ctxResult=value end}\nassert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='running')\nassert(#calls==2 and calls[1][1]==15 and calls[1][2]==1 and calls[2][2]==2 and calls[1][3]==false and calls[2][3]==false)\nassert(ctx.memory.cleanup==nil and ctxResult.phase=='submitted')\nctx.now=0.1;assert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='running' and #calls==2)\nnpc.SkillGroupComponent.CurrentSkill={Id=999,RunFrame=0};assert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='running')\nnpc.SkillGroupComponent.CurrentSkill={Id=101,RunFrame=0};assert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='succeeded' and ctxResult.phase=='skill_started')\nprint('PASS 普攻候选仅提交一对正常按键，指定技能开始才成功')\n\nnpc.SkillGroupComponent.CurrentSkill=nil\nctx.memory={};ctx.now=0;assert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='running')\nctx.now=3;assert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='failed' and ctxResult.phase=='failed')\nprint('PASS 未观察到技能开始则失败，不悬挂也不自动重发输入')\n\nfor _,key in ipairs({'IsReplay','IsLockstep','ShieldOperation'}) do\n    fight[key]=true;assert(not BehaviorTreeCapabilityChecks['fight.normal_attack'].available(fight));fight[key]=false\nend\nCS.XInputControl.ForceClickForDebug=true\nassert(not BehaviorTreeCapabilityChecks['fight.normal_attack'].available(fight))\nprint('PASS 回放、联机、屏蔽、调试强制输入不宣告控制能力')\n\nlocal function n(id,t,p,c) return {id=id,type=t,version=1,params=p or {},children=c or {}} end\nlocal clock=0\nlocal sent={}\nlocal host={now=function() return clock end,scene=function() return 'test' end,send=function(x) sent[#sent+1]=x end}\nlocal bt=CreateBehaviorTree(host,BehaviorTreeDefinitions,BehaviorTreeHandlers)\nlocal function tree(nodes) return {schemaVersion=1,id='quality',root='root',nodes=nodes,blackboard={},roles={}} end\nlocal t=tree({n('root','wait',{seconds=1})})\nfor _,v in ipairs({false,1,'bad'}) do t.roles=v;assert(not bt.validate(t).ok) end\nt.roles={};t.blackboard={a=0/0};assert(not bt.validate(t).ok)\nt.blackboard={};t.blackboard.self=t.blackboard;assert(not bt.validate(t).ok)\nt.blackboard={fn=function() end};assert(not bt.validate(t).ok)\nt.blackboard={};t.nodes[1].params.seconds=math.huge;assert(not bt.validate(t).ok)\nassert(not bt.validate(tree({n('root','parallel',{successThreshold=2},{'w'}),n('w','wait',{seconds=0})})).ok)\nprint('PASS 畸形值、循环、非有限数与并行阈值拒绝')\nassert(BehaviorTreeHandlers.blackboard_equals({params={key='x',value={a={1,2}}},run={blackboard={x={a={1,2}}}}})=='succeeded')\nprint('PASS 嵌套黑板结构等值')\nlocal function request(id,action,p)\n bt.handle({protocolVersion=1,requestId=id,action=action,payload=p});return sent[#sent]\nend\nlocal cleanup=0; local actions=0\nBehaviorTreeHandlers.gameobject_offset=function(ctx)\n if ctx.params.x==1 then\n   assert(cleanup==1,'new action before cleanup');actions=actions+1;return 'succeeded'\n end\n ctx.memory.cleanup=function() cleanup=cleanup+1 end;return 'running'\nend\nlocal token=bt.registerObject('go','gameobject','go',{},function() return true end,{'gameobject.transform.debug'})\nt=tree({n('root','selector',{reactive=true},{'branch','old'}),n('branch','sequence',{}, {'cond','new'}),n('cond','blackboard_equals',{key='choose',value=true}),n('new','gameobject_offset',{role='target',x=1,y=0,z=0,seconds=1}),n('old','gameobject_offset',{role='target',x=0,y=0,z=0,seconds=1})})\nt.roles={target={kind='gameobject'}}\nassert(request('i','install',{tree=t}).data.ok)\nassert(request('r','start',{treeId=t.id,bindings={target=token}}).ok)\nbt.update();assert(cleanup==0)\nbt.runs.r.blackboard.choose=true;bt.update();assert(cleanup==1 and actions==1 and bt.runs.r.state=='succeeded')\nprint('PASS 响应式抢占在新动作前清理旧动作')\n-- 延迟结果与停止：已提交动作仅一次，后续更新只观察。\nCS.XInputControl.ForceClickForDebug=false\nlocal npc={IsActivate=true,IsDead=false,IsDeleted=false,SkillGroupComponent={}}\nlocal player={Npc=npc};local calls={}\nlocal fight={State=CS.XFightState.Fight,Frame=1,GetClientRole=function()return player end,InputControl={OnClick=function(_,key,kind)calls[#calls+1]=kind end}}\nlocal result\nlocal ctx={params={role='player',output='result',timeout=2,expectedSkillId=101},memory={},now=0,object=function()return fight end,write=function(_,x)result=x end}\nassert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='running')\nfight.ShieldOperation=true;assert(BehaviorTreeHandlers.fight_normal_attack(ctx)=='failed' and result.reason=='input_capability_lost' and #calls==2)\nfight.ShieldOperation=false\nplayer.ControlNpc={};assert(not BehaviorTreeCapabilityChecks['fight.normal_attack'].available(fight));player.ControlNpc=nil\nCS.XInputControl.ForceClickForDebug=nil;assert(not BehaviorTreeCapabilityChecks['fight.normal_attack'].available(fight));CS.XInputControl.ForceClickForDebug=false\nctx.memory={};fight.InputControl.OnClick=function(_,key,kind)calls[#calls+1]=kind;if kind==CS.XOperationClickType.KeyDown then error('down failed') end end\nassert(not pcall(BehaviorTreeHandlers.fight_normal_attack,ctx));assert(ctx.memory.cleanup);ctx.memory.cleanup();assert(calls[#calls]==CS.XOperationClickType.KeyUp)\nctx.memory={};local first=true\nfight.InputControl.OnClick=function(_,key,kind) calls[#calls+1]=kind;if kind==CS.XOperationClickType.KeyUp and first then first=false;error('up failed')end end\nassert(not pcall(BehaviorTreeHandlers.fight_normal_attack,ctx));ctx.memory.cleanup();assert(calls[#calls]==CS.XOperationClickType.KeyUp)\nprint('PASS 能力丢失、缺API与按下/抬起异常释放')\n-- 预算故障注入验证异常收尾，不声称合法256节点树会耗尽512预算。\nbt=CreateBehaviorTree(host,BehaviorTreeDefinitions,BehaviorTreeHandlers)\ncleanup=0\nBehaviorTreeHandlers.blackboard_set=function(ctx)\n ctx.run.budget=-1;ctx.memory.cleanup=function()cleanup=cleanup+1 end;return 'succeeded'\nend\nt=tree({n('root','sequence',{}, {'consume','next'}),n('consume','blackboard_set',{key='x',value=1}),n('next','wait',{seconds=0})})\nassert(request('budget-i','install',{tree=t}).data.ok)\nassert(request('budget-r','start',{treeId=t.id}).ok)\nbt.update();assert(bt.runs['budget-r'].state=='error' and cleanup==1 and bt.runs['budget-r'].reason:find('tick_budget'))\nprint('PASS 预算异常清理一次（故障注入）')\nbt=CreateBehaviorTree(host,BehaviorTreeDefinitions,BehaviorTreeHandlers)\ncleanup=0\nBehaviorTreeHandlers.gameobject_offset=function(ctx) ctx.memory.cleanup=function()cleanup=cleanup+1 end;return 'running' end\ntoken=bt.registerObject('go','gameobject','go',{},function()return true end,{'gameobject.transform.debug'})\nt=tree({n('root','timeout',{seconds=1},{'move'}),n('move','gameobject_offset',{role='target',x=0,y=0,z=0,seconds=10})});t.roles={target={kind='gameobject'}}\nclock=0;assert(request('timeout-i','install',{tree=t}).data.ok);assert(request('timeout-r','start',{treeId=t.id,bindings={target=token}}).ok)\nbt.update();clock=1;bt.update();assert(bt.runs['timeout-r'].state=='failed' and cleanup==1);bt.update();assert(cleanup==1)\nprint('PASS 超时边界清理一次且终止后不再tick')\n")


def test_status_restores_actual_run_tree_without_changing_execution(vm):
    lua, convert = vm
    original = tree([node('root', 'wait', {'seconds': 100})])
    original['name'] = 'running revision'
    install_start(vm, original)
    lua.execute('bt.update()')
    request = lua.globals().request
    replacement = tree([node('root', 'wait', {'seconds': 1})])
    replacement['name'] = 'later installed revision'
    request('replace', 'install', convert({'tree': replacement}))
    lua.execute('clock=20')
    run = request('read', 'status', convert({'includeTree': True}))['data']['runs'][1]
    assert run['tree']['name'] == 'running revision'
    assert run['startedAt'] == 0
    run['tree']['nodes'][1]['params']['seconds'] = 999
    assert lua.globals().bt.runs['start'].tree.nodes[1].params.seconds == 100
    brief = request('brief', 'status', convert({}))['data']['runs'][1]
    assert brief['tree'] is None
    lua.execute('clock=31;bt.update()')
    assert lua.globals().bt.runs['start'].state == 'running'
    lua.execute('clock=100;bt.update()')
    assert lua.globals().bt.runs['start'].state == 'succeeded'


def test_client_execution_survives_browser_absence_and_restores_same_run(vm):
    lua, convert = vm
    data = tree([node('root', 'sequence', children=['mark', 'wait']), node('mark', 'blackboard_set', {'key': 'started', 'value': 1}), node('wait', 'wait', {'seconds': 120})])
    install_start(vm, data)
    lua.execute('bt.update(); clock=65; bt.update()')
    run = lua.globals().bt.runs['start']
    assert run.state == 'running' and run.blackboard.started == 1
    assert run.runMode == 'autonomous'
    assert run.deadline is None and run.leaseUntil is None and run.maxRunSeconds is None
    # 浏览器消失65秒后只读回查，不重启树，仍是同一份黑板和树。
    snapshot = lua.globals().request('reopen', 'status', convert({'includeTree': True}))['data']['runs'][1]
    assert snapshot['runId'] == 'start' and snapshot['runMode'] == 'autonomous'
    assert snapshot['blackboard']['started'] == 1 and snapshot['tree']['id'] == 'test'
    lua.execute('clock=121; bt.update()')
    assert run.state == 'succeeded'


@pytest.mark.parametrize('renew_lease', [False, True])
def test_client_execution_has_no_browser_lease_or_global_deadline(vm, renew_lease):
    lua, convert = vm
    data=tree([
        node('root','sequence',children=['mark','repeat']),
        node('mark','blackboard_set',{'key':'started','value':1}),
        node('repeat','repeat',{'count':1000},['wait']),
        node('wait','wait',{'seconds':300}),
    ])
    assert install_start(vm,data)['ok']
    lua.execute('bt.update()')
    run=lua.globals().bt.runs['start']
    for elapsed in (31,3601,86401,1000000):
        lua.execute(f'clock={elapsed};bt.update()')
        snapshot=lua.globals().request(f'status-{elapsed}','status',convert({'renewLease':renew_lease}))['data']['runs'][1]
        assert run.state == 'running' and run.reason is None
        assert run.runMode == 'autonomous'
        assert run.deadline is None and run.leaseUntil is None and run.maxRunSeconds is None
        assert snapshot['runId'] == 'start' and snapshot['blackboard']['started'] == 1
        assert snapshot['maxRunSeconds'] is None
    # 长时推进不会自动清理或换成另一次运行；显式停止仍生效。
    lua.globals().request('stop','stop',convert({'runId':'start'}))
    assert run.state == 'stopped' and run.reason == 'user_stop'


def test_tree_timeout_still_cleans_owned_input_once(vm):
    lua, _ = vm
    lua.execute("token=bt.registerObject('x','gameobject','probe',{},function() return true end,{'gameobject.transform.debug'})")
    data=tree([
        node('root','timeout',{'seconds':40},['move']),
        node('move','gameobject_offset',dict(role='target',x=1,y=0,z=0,seconds=100)),
    ],roles={'target':{'kind':'gameobject'}})
    assert install_start(vm,data,{'target':lua.globals().token})['ok']
    lua.execute('bt.update();clock=39;bt.update()')
    run=lua.globals().bt.runs['start']
    assert run.state == 'running' and lua.globals().cleaned == 0
    lua.execute('clock=40;bt.update();clock=1000000;bt.update()')
    assert run.state == 'failed' and run.states.move == 'cancelled'
    assert lua.globals().cleaned == 1


def test_capabilities_describe_only_tree_owned_execution_lifetime(vm):
    lua, convert = vm
    capabilities=lua.globals().request('capabilities','capabilities',convert({}))['data']
    assert capabilities['runtimeBuild'] == 'ency-bt-20261110-r22'
    assert capabilities['executionLifetime'] == 'tree'
    assert list(capabilities['runModes'].values()) == ['autonomous']


@pytest.mark.parametrize('same_object', [True, False])
def test_parallel_start_checks_bound_object_aliases_before_actions(vm, same_object):
    lua, convert = vm
    lua.execute('''
        actions=0
        BehaviorTreeHandlersExport.gameobject_offset=function(ctx)
            ctx.object(ctx.params.role)
            actions=actions+1
            return 'running'
        end
        leftToken=bt.registerObject('left-go','gameobject','left',{},function() return true end,{'gameobject.transform.debug'})
        rightToken=bt.registerObject('right-go','gameobject','right',{},function() return true end,{'gameobject.transform.debug'})
    ''')
    data=tree([
        node('root','parallel',children=['a','b']),
        node('a','gameobject_offset',dict(role='left',x=1,y=0,z=0,seconds=1)),
        node('b','gameobject_offset',dict(role='right',x=-1,y=0,z=0,seconds=1)),
    ],roles={'left':{'kind':'gameobject'},'right':{'kind':'gameobject'}})
    # 离线结构无法判断别名，安装保留；执行前按真实绑定核验。
    assert validate_tree(data)['ok']
    left=lua.globals().leftToken
    right=left if same_object else lua.globals().rightToken
    result=install_start(vm,data,{'left':left,'right':right})
    lua.execute('bt.update()')
    if same_object:
        assert result['ok'] is False
        assert 'parallel_resource_conflict' in result['error']['message']
        assert lua.globals().bt.runs['start'] is None
        assert lua.globals().actions == 0
    else:
        assert result['ok'] is True
        assert lua.globals().bt.runs['start'].state == 'running'
        assert lua.globals().actions == 2


def test_parallel_read_only_aliases_remain_valid(vm):
    lua, _ = vm
    lua.execute('''
        local go={name='shared',activeSelf=true,transform={position={x=1,y=2,z=3}}}
        readToken=bt.registerObject('same-go','gameobject','shared',go,function() return true end,{'gameobject.read'})
    ''')
    data=tree([
        node('root','parallel',children=['a','b']),
        node('a','gameobject_read',dict(role='left',output='leftRead')),
        node('b','gameobject_read',dict(role='right',output='rightRead')),
    ],roles={'left':{'kind':'gameobject'},'right':{'kind':'gameobject'}})
    token=lua.globals().readToken
    assert install_start(vm,data,{'left':token,'right':token})['ok'] is True
    lua.execute('bt.update()')
    run=lua.globals().bt.runs['start']
    assert run.state == 'succeeded'
    assert run.blackboard.leftRead.name == 'shared'
    assert run.blackboard.rightRead.x == 1


def test_status_summary_and_diagnostic_fields_are_opt_in_without_mutating_runs():
    lupa=pytest.importorskip('lupa')
    lua=lupa.LuaRuntime(unpack_returned_tuples=True)
    source=read_runtime_gm_source().split('-- 2. RuntimeGMClient')[0]
    # 三份离线历史样本；真实内核生成事件，真实私有JSON编码，不代表线上耗时。
    result=json.loads(lua.execute(source + r'''
        local clock=0
        local packets={}
        local bt=CreateBehaviorTree({now=function() return clock end,scene=function() return 'one' end,
            send=function(p) packets[#packets+1]=p end},BehaviorTreeDefinitions,BehaviorTreeHandlers)
        local function request(id,action,payload)
            bt.handle({protocolVersion=1,requestId=id,action=action,payload=payload or {}})
            assert(packets[#packets].ok)
            return packets[#packets]
        end
        local tree={schemaVersion=1,id='status-sample',root='repeat',roles={},blackboard={},nodes={
            {id='repeat',type='repeat',version=1,params={count=90},children={'write'}},
            {id='write',type='blackboard_set',version=1,params={key='payload',value={message=string.rep('x',4096),nested={value=42}}},children={}}
        }}
        assert(request('install','install',{tree=tree}).data.ok)
        for i=1,3 do
            request('start-'..i,'start',{treeId=tree.id,runId='run-'..i})
            for tick=1,(i==3 and 20 or 90) do clock=clock+0.05;bt.update() end
        end
        local all=request('all','status')
        assert(#all.data.runs==3)
        for _,run in ipairs(all.data.runs) do
            assert(run.nodes and run.blackboard and run.events and run.eventSeq>0)
            assert(run.tree==nil)
        end
        local summary=request('summary','status',{summary=true,includeTree=true})
        assert(#summary.data.runs==3)
        for _,run in ipairs(summary.data.runs) do
            assert(run.nodes==nil and run.blackboard==nil and run.events==nil and run.tree==nil)
            assert(run.eventSeq>0)
        end
        local light=request('light','status',{runId='run-3',includeEvents=false,includeBlackboard=false})
        local item=light.data.runs[1]
        assert(#light.data.runs==1 and item.nodes.write=='succeeded' and item.nodes['repeat']=='running')
        assert(item.events==nil and item.blackboard==nil and item.tree==nil)
        local withTree=request('tree','status',{runId='run-3',includeEvents=false,includeBlackboard=false,includeTree=true})
        assert(withTree.data.runs[1].tree.nodes[1].type=='repeat')
        -- 省略只是回包选择，不删除内核运行数据；再打开诊断仍能取全量。
        local after=request('after','status',{runId='run-3'}).data.runs[1]
        assert(after.blackboard.payload.nested.value==42 and #after.blackboard.payload.message==4096)
        assert(#after.events>0 and after.eventSeq==item.eventSeq)
        assert(#bt.runs['run-3'].events==#after.events)
        local measurements={sampleRuns=3,allRunsBytes=#BehaviorTreeJson.encode(all),
            summaryBytes=#BehaviorTreeJson.encode(summary),singleLightBytes=#BehaviorTreeJson.encode(light),
            withTreeBytes=#BehaviorTreeJson.encode(withTree),eventSeq=after.eventSeq,
            preservedEvents=#after.events,preservedBlackboardMessageBytes=#after.blackboard.payload.message}
        assert(measurements.allRunsBytes>measurements.summaryBytes)
        assert(measurements.allRunsBytes>measurements.singleLightBytes)
        return BehaviorTreeJson.encode(measurements)
    '''))
    assert result['sampleRuns'] == 3
    assert result['preservedBlackboardMessageBytes'] == 4096
    print('status_payload_bytes=' + json.dumps(result,sort_keys=True))

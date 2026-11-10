"""实际 Lua 节点与内核的离线回归，不代替游戏联调。"""
import pytest

from tools.gm_console.runtime_gm_code import read_runtime_gm_source


@pytest.fixture
def attack_vm():
    lua = pytest.importorskip('lupa').LuaRuntime(unpack_returned_tuples=True)
    source = read_runtime_gm_source().split('-- 2. RuntimeGMClient')[0]
    lua.execute(source + '''
        CS={XFightState={Fight='Fight'},XInputControl={ForceClickForDebug=false},
            XNpcOperationClickKey={NormalAttackKey=15},XOperationClickType={KeyDown=1,KeyUp=2}}
        clock=0; calls=0
        npc={IsActivate=true,IsDead=false,IsDeleted=false,SkillGroupComponent={}}
        fight={State='Fight',Frame=1,GetClientRole=function() return {Npc=npc} end,
            InputControl={OnClick=function(_,_,_,force) assert(force==false);calls=calls+1 end}}
        ctx={params={role='player',output='attack',timeout=2,expectedSkillId=101},memory={},now=0,
            object=function() return fight end,write=function(_,value) result=value end}
        function attack() return BehaviorTreeHandlers.fight_normal_attack(ctx) end
        bt=CreateBehaviorTree({now=function() return clock end,scene=function() return 'scene' end,
            send=function(value) response=value end},BehaviorTreeDefinitions,BehaviorTreeHandlers)
        token=bt.registerObject('player','fight','player',fight,function() return true end,{'fight.normal_attack'})
        function start(kind)
            local tree={schemaVersion=1,id='attack-test',root='root',roles={player={kind='fight'}},blackboard={},
                nodes={{id='root',type=kind,version=1,params={},children={'attack','fallback'}},
                    {id='attack',type='fight_normal_attack',version=1,children={},params=ctx.params},
                    {id='fallback',type='blackboard_set',version=1,children={},params={key='continued',value=true}}}}
            bt.handle({protocolVersion=1,requestId='install',action='install',payload={tree=tree}})
            assert(response.ok and response.data.ok)
            bt.handle({protocolVersion=1,requestId='run',action='start',payload={treeId=tree.id,bindings={player=token}}})
            assert(response.ok)
        end
    ''')
    return lua


@pytest.mark.parametrize('cause', ['timeout', 'capability'])
def test_attack_failure_reaches_selector_fallback(attack_vm, cause):
    lua = attack_vm
    lua.execute("start('selector');bt.update()")
    if cause == 'timeout':
        lua.execute('clock=2;bt.update()')
        reason = 'no_skill_start_evidence'
    else:
        lua.execute('fight.ShieldOperation=true;bt.update()')
        reason = 'input_capability_lost'
    run = lua.globals().bt.runs.run
    assert run.state == 'succeeded'
    assert run.states.attack == 'failed'
    assert run.blackboard.continued is True
    assert run.blackboard.attack.reason == reason
    lua.execute('bt.update()')
    assert lua.globals().calls == 2


def test_attack_timeout_ends_sequence_and_allows_new_run(attack_vm):
    lua = attack_vm
    lua.execute("start('sequence');bt.update();clock=2;bt.update()")
    run = lua.globals().bt.runs.run
    assert run.state == 'failed'
    assert run.blackboard.continued is None
    assert run.blackboard.attack.expectedSkillId == 101
    assert lua.globals().calls == 2
    lua.execute('''
        bt.handle({protocolVersion=1,requestId='next',action='start',payload={treeId='attack-test',bindings={player=token}}})
        assert(response.ok and response.data.state=='running')
    ''')


def test_reused_skill_restart_compares_previous_observation(attack_vm):
    lua = attack_vm
    lua.execute('npc.SkillGroupComponent.CurrentSkill={Id=101,RunFrame=0}')
    assert lua.globals().attack() == 'running'
    lua.execute('ctx.now=0.1;npc.SkillGroupComponent.CurrentSkill.RunFrame=8')
    assert lua.globals().attack() == 'running'
    # 同一个对象重启到第 1 帧，仍大于提交时的第 0 帧。
    lua.execute('ctx.now=0.2;npc.SkillGroupComponent.CurrentSkill.RunFrame=1')
    assert lua.globals().attack() == 'succeeded'
    assert lua.globals().result.phase == 'skill_started'
    assert lua.globals().calls == 2


def test_reused_skill_id_change_is_observed(attack_vm):
    lua = attack_vm
    lua.execute('npc.SkillGroupComponent.CurrentSkill={Id=999,RunFrame=0}')
    assert lua.globals().attack() == 'running'
    lua.execute('ctx.now=0.1;npc.SkillGroupComponent.CurrentSkill.Id=101')
    assert lua.globals().attack() == 'succeeded'


def test_ongoing_skill_does_not_count_as_new_attack(attack_vm):
    lua = attack_vm
    lua.execute('npc.SkillGroupComponent.CurrentSkill={Id=101,RunFrame=0}')
    assert lua.globals().attack() == 'running'
    lua.execute('ctx.now=0.1;npc.SkillGroupComponent.CurrentSkill.RunFrame=8')
    assert lua.globals().attack() == 'running'
    lua.execute('ctx.now=2;npc.SkillGroupComponent.CurrentSkill.RunFrame=12')
    assert lua.globals().attack() == 'failed'
    assert lua.globals().result.observedSkillId == 101
    assert lua.globals().calls == 2
